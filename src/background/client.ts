import {
    Highlight, HIGHLIGHT_COLOR_KEY,
    HIGHLIGHT_EDIT_EVENT_TYPE,
    HIGHLIGHT_EDIT_REL_TYPE,
    HIGHLIGHT_EVENT_DATA,
    HIGHLIGHT_EVENT_TYPE,
    HIGHLIGHT_HTML_KEY,
    HIGHLIGHT_NEW_HIGHLIGHT_KEY,
    HIGHLIGHT_PAGE_KEY,
    HIGHLIGHT_STATE_EVENT_TYPE,
    HIGHLIGHT_TEXT_KEY,
    HighlightContent,
    Message,
    Room,
    User,
} from '../common/model'
import {FromContentMessage, RoomMembership, SendHighlightMessage, ToContentMessage} from '../common/messages'
import * as sdk from 'matrix-js-sdk'
import {BackgroundPlatform} from './backgroundPlatform'

const threadRelation = "m.thread"

function extractTxnId(event: sdk.MatrixEvent): number | undefined {
    let localId = undefined;
    const transactionId = event.getUnsigned().transaction_id;
    if (transactionId) {
        const number = parseInt(transactionId);
        if (!isNaN(number)) localId = number;
    }
    return localId;
}

function eventToMessage(event: sdk.MatrixEvent): Message {
    return new Message({
        id: event.getId(),
        plainBody: event.getContent().body,
        formattedBody: event.getContent().formatted_body,
        userId: event.getSender(),
    });
}

export class Client {
    constructor(private _sdkClient: sdk.MatrixClient, private _platform: BackgroundPlatform){}

    async createRoom(name: string, url: string): Promise<void> {
        await this._sdkClient.createRoom({
            name,
            creation_content: {
                [HIGHLIGHT_PAGE_KEY]: url
            },
        });
    }

    private async _broadcastRoom(message: ToContentMessage | ToContentMessage[] | null, target: string | sdk.Room): Promise<void> {
        if (typeof target === "string") {
            target = this._sdkClient.getRoom(target);
        }
        const url = this._checkRoom(target);
        if (!url || !message) return;
        return this._platform.broadcast(message, url);
    }

    private _checkRoom(room: sdk.Room): string | undefined {
        const state = room.getLiveTimeline().getState(sdk.EventTimeline.FORWARDS);

        const createEvent = state.getStateEvents("m.room.create", "");
        const configEvent = state.getStateEvents(HIGHLIGHT_STATE_EVENT_TYPE, "")

        return configEvent?.getContent()?.url || createEvent.getContent()[HIGHLIGHT_PAGE_KEY];
    }

    private _processRoom(room: sdk.Room): ToContentMessage[] {
        if (this._sdkClient.isRoomEncrypted(room.roomId)) return [];
        const events: ToContentMessage[] = [];
        events.push({
            type: "add-room",
            room: new Room({
                id: room.roomId,
                name: room.name,
                membership: room.getMember(this._sdkClient.getUserId())!.membership
            })
        });
        for (const event of room.getLiveTimeline().getEvents()) {
            const contentEvent = this._processEvent(event);
            if (contentEvent) events.push(contentEvent);
        }
        for (const member of room.getMembers()) {
            events.push(this._processMember(room.roomId, null, member));
        }
        return events;
    };

    private async _emitRoom(room: sdk.Room): Promise<void> {
        await this._broadcastRoom(this._processRoom(room), room.roomId);
    }

    private _processMember(roomId: string, oldMembership: RoomMembership | null, member: sdk.RoomMember): ToContentMessage {
        if (oldMembership === null) {
            const user = new User({
                id: member.userId,
                name: member.name,
                membership: member.membership,
            });
            return { type: "add-user", roomId, user };
        } else {
            return {
                type: "user-membership",
                roomId,
                userId: member.userId,
                membership: member.membership as RoomMembership
            };
        }
    };

    private async _emitMember(roomId: string, oldMembership: RoomMembership | null, member: sdk.RoomMember): Promise<void>{
        await this._broadcastRoom(this._processMember(roomId, oldMembership, member), roomId);
    }

    private _addExistingReplies(event: sdk.MatrixEvent, highlight: Highlight): void {
        const timelineSet = this._sdkClient.getRoom(event.getRoomId()!).getUnfilteredTimelineSet();
        const threadReplies = timelineSet.getRelationsForEvent(event.getId(), threadRelation, "m.room.message");
        if (!threadReplies) return;
        for (const threadEvent of threadReplies.getRelations().sort((e1, e2) => e1.getTs() - e2.getTs())) {
            highlight.addRemoteMessage(eventToMessage(threadEvent), undefined);
        }
    }

    private _useLatestContent(event: sdk.MatrixEvent, highlight: Highlight): void {
        const timelineSet = this._sdkClient.getRoom(event.getRoomId()!).getUnfilteredTimelineSet();
        const edits = timelineSet.getRelationsForEvent(event.getId(), HIGHLIGHT_EDIT_REL_TYPE as any, HIGHLIGHT_EDIT_EVENT_TYPE);
        if (!edits) return;
        const sortedEdits = edits.getRelations().sort((e1, e2) => e1.getTs() - e2.getTs());
        const lastEdit = sortedEdits[sortedEdits.length - 1]
        highlight.content = lastEdit.getContent()[HIGHLIGHT_NEW_HIGHLIGHT_KEY];
    }

    private _processEvent(event: sdk.MatrixEvent, placeAtTop: boolean = false): ToContentMessage | null {
        switch (event.getType()) {
            case HIGHLIGHT_EVENT_TYPE: {
                // All new highlights are transported over 'm.room.message' events,
                // but we're keep this for back-compatibility
                return this.highlightEvent(event, event.getContent<HighlightContent>(), placeAtTop)
            }
            case HIGHLIGHT_EDIT_EVENT_TYPE: {
                const highlightId = event.getRelation()?.["event_id"];
                const newContent = event.getContent()[HIGHLIGHT_NEW_HIGHLIGHT_KEY] as HighlightContent
                if (!highlightId) return null;
                return {
                    type: "highlight-content",
                    roomId: event.getRoomId()!,
                    highlightId,
                    highlight: newContent
                };
            }
            case 'm.room.message': {
                const eventContent = event.getContent();
                if (eventContent[HIGHLIGHT_EVENT_DATA]) {
                    return this.highlightEvent(event, eventContent[HIGHLIGHT_EVENT_DATA], placeAtTop);
                }

                if (!event.isThreadRelation || event.isThreadRoot) return null
                return {
                    type: 'thread-message',
                    roomId: event.getRoomId()!,
                    threadId: event.threadRootId!,
                    txnId: extractTxnId(event),
                    message: eventToMessage(event),
                    placeAtTop,
                }
            }
            default: return null;
        }
    }

    private highlightEvent(
        event: sdk.MatrixEvent,
        highlightContent: HighlightContent,
        placeAtTop: boolean
    ): ToContentMessage {
        const highlight = new Highlight(event.getId(), highlightContent)
        this._addExistingReplies(event, highlight)
        this._useLatestContent(event, highlight)
        return {
            type: 'highlight',
            roomId: event.getRoomId()!,
            txnId: extractTxnId(event),
            highlight: highlight,
            placeAtTop,
        }
    }

    private async _emitEvent(event: sdk.MatrixEvent, placeAtTop: boolean): Promise<void> {
        await this._broadcastRoom(this._processEvent(event, placeAtTop), event.getRoomId()!);
    };

    setup() {
        this._sdkClient.on("sync", state => {
            if (state !== "PREPARED") return;
            this._platform.broadcast({ type: "sync-complete" });
            // During initial sync, we receive events from rooms. That's nice,
            // but if we also process the timelines of rooms we select, we end
            // up double-counting events. So instead, ignore events from initial
            // sync, and process them manually afterwards.
            this._sdkClient.on("Room", (room: sdk.Room) => {
                this._emitRoom(room);
            });
            this._sdkClient.on("Room.name", (room: sdk.Room) => {
                const roomId = room.roomId;
                this._broadcastRoom({ type: "room-name", roomId, name: room.name }, roomId);
            });
            this._sdkClient.on("Room.myMembership", (room: sdk.Room, membership: string) => {
                this._broadcastRoom({
                    type: "room-membership",
                    roomId: room.roomId,
                    membership: membership as RoomMembership
                }, room.roomId);
            });
            this._sdkClient.on("event", (event: sdk.MatrixEvent) => {
                this._emitEvent(event, false);
            });
            this._sdkClient.on("Room.timeline", (event: sdk.MatrixEvent, room: sdk.Room, toStartOfTimeline: boolean, removed: boolean, data: {liveEvent: boolean}) => {
                if (event.getType() === HIGHLIGHT_STATE_EVENT_TYPE) {
                    this._emitRoom(room);
                    this._broadcastRoom({
                        type: "room-configured",
                        roomId: room.roomId,
                    }, room.roomId)
                }
                if (!data.liveEvent) this._emitEvent(event, toStartOfTimeline);
            });
            this._sdkClient.on("RoomMember.membership", (event: sdk.MatrixEvent, member: sdk.RoomMember, oldMembership: RoomMembership | null) => {
                this._emitMember(event.getRoomId()!, oldMembership, member);
            });
            for (const room of this._sdkClient.getRooms()) {
                this._emitRoom(room);
            }
        });
    }

    async start() {
        await this._sdkClient.startClient({initialSyncLimit: 100});
    }


    loginMessage(): ToContentMessage {
        return { type: "logged-in", userId: this._sdkClient.getUserId(), homeserver: this._sdkClient.getHomeserverUrl() };
    }

    catchupMessages(forUrl: string): ToContentMessage[] {
        const messages = [this.loginMessage()];
        if (!this._sdkClient.isInitialSyncComplete()) return messages;
        messages.push({ type: "sync-complete" });
        for (const room of this._sdkClient.getRooms()) {
            const url = this._checkRoom(room);
            if (!url || url !== forUrl) continue;
            const roomEvents = this._processRoom(room);
            messages.push(...roomEvents);
        }
        return messages;
    }

    private async _sendThreadMessage(roomId: string, threadId: string, plainBody: string, formattedBody: string, txnId: number): Promise<void> {
        await this._sdkClient.sendEvent(roomId, "m.room.message", {
            "msgtype": "m.text",
            "body": plainBody,
            "formatted_body": formattedBody,
            "m.relates_to": {
                "rel_type": threadRelation,
                "event_id": threadId,
            }
        }, txnId.toString());
    }

    private async _sendHighlightEdit(roomId: string, highlightId: string, newContent: HighlightContent): Promise<void> {
        await this._sdkClient.sendEvent(roomId, HIGHLIGHT_EDIT_EVENT_TYPE, {
            "msgtype": "m.text",
            "body": "Changed highlight",
            "m.relates_to": {
                "rel_type": HIGHLIGHT_EDIT_REL_TYPE,
                "event_id": highlightId
            },
            [HIGHLIGHT_NEW_HIGHLIGHT_KEY]: newContent
        });
    }

    private async _loadRoom(roomId: string) {
        const room = this._sdkClient.getRoom(roomId);
        if (!room) return;
        const continuePagination = async () => {
            const more = await this._sdkClient.paginateEventTimeline(room.getLiveTimeline(), {backwards: true, limit: 100});
            if (more) await continuePagination();
        }
        await continuePagination();
    }

    async handleMessage(message: FromContentMessage): Promise<void> {
        if (message.type === "join-room") {
            await this._sdkClient.joinRoom(message.roomId);
        } else if (message.type === "join-configure-room") {
            await this.joinAndConfigureRoom(message.roomId, message.url)
        } else if (message.type === "leave-room") {
            await this._sdkClient.leave(message.roomId);
        }  else if (message.type === "invite-user") {
            await this._sdkClient.invite(message.roomId, message.userId);
        } else if (message.type === "send-highlight") {
            await this.sendHighlight(message)
        } else if (message.type === "edit-highlight") {
            this._sendHighlightEdit(message.roomId, message.highlightId, message.highlight);
        } else if (message.type === "send-thread-message") {
            this._sendThreadMessage(message.roomId, message.threadId, message.plainBody, message.formattedBody, message.txnId);
        } else if (message.type === "load-room") {
            this._loadRoom(message.roomId);
        }
    }

    private async sendHighlight(message: SendHighlightMessage) {
        await this._sdkClient.sendMessage(message.roomId, {
            msgtype: 'm.text',
            format: 'org.matrix.custom.html',

            body: message.highlight[HIGHLIGHT_TEXT_KEY].join('\n'),
            formatted_body: buildFormattedMessage(message),
            [HIGHLIGHT_EVENT_DATA]: message.highlight,
        }, message.txnId.toString())
    }

    private async joinAndConfigureRoom(roomId: string, url: string) {
        await this._sdkClient.joinRoom(roomId)
        // TODO: this doesn't really work as intended rn.
        //  The default synapse configuration is to required power level 50 (moderator) to send custom state events
        //  So what actually needs to happen is that you join the room first, get moderator status and then
        //  use "join" functionality in the extension to configure the room
        //  _
        //  It works ok, if someone else has already configured the room and you're just joining it though.
        await this._sdkClient.sendStateEvent(roomId, HIGHLIGHT_STATE_EVENT_TYPE, {url}, "");
    }
}

function buildFormattedMessage(message: SendHighlightMessage) {
    const color = message.highlight[HIGHLIGHT_COLOR_KEY]
    const text = message.highlight[HIGHLIGHT_HTML_KEY]

    // TODO: Element seems to ignore the style information =\
    //  So this only benefits clients that render the formatted_body more faithfully.
    //  That said, one can do better than this, by maybe adding more structure to HTML
    const style = `background-color: ${color};`

    // TODO: Ideally this should be a link to the highlight
    //  Using a fragment link could be a good starting point before having a special format that triggers the extension

    return `<blockquote style="${style}">${text}</blockquote>`
}
