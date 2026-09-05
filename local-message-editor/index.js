const React = globalThis.React;
import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";
import { before, after } from "@vendetta/patcher";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";
import { findInReactTree } from "@vendetta/utils";
const MessageStore = findByStoreName("MessageStore");
const UserStore = findByStoreName("UserStore");
const ActionSheet = findByProps("openLazy", "hideActionSheet");
const MessageActions = findByProps("startEditMessage", "editMessage");
const ActionSheetModule = findByProps("ActionSheetRow");
const ActionSheetRow = ActionSheetModule?.ActionSheetRow ??
    Forms.FormRow;
const savedMessages = new Map();
let patches = [];
let editingId = null;
function clone(message) {
    try {
        return JSON.parse(JSON.stringify(message));
    }
    catch {
        return { ...message };
    }
}
function getMessage(message) {
    try {
        return (MessageStore?.getMessage(message.channel_id, message.id) ?? message);
    }
    catch {
        return message;
    }
}
function isOwnMessage(message) {
    try {
        const user = UserStore?.getCurrentUser?.();
        return Boolean(user?.id &&
            message?.author?.id &&
            user.id === message.author.id);
    }
    catch {
        return false;
    }
}
function addButton(buttons, message) {
    if (!Array.isArray(buttons))
        return;
    if (!message?.id)
        return;
    if (buttons.some((button) => button?.props?.label ===
        "Edit Locally")) {
        return;
    }
    const current = getMessage(message);
    if (isOwnMessage(current)) {
        return;
    }
    const editLocally = () => {
        try {
            editingId = current.id;
            if (!savedMessages.has(current.id)) {
                savedMessages.set(current.id, clone(current));
            }
            ActionSheet?.hideActionSheet?.();
            MessageActions?.startEditMessage?.(current.channel_id, current.id, current.content ?? "");
        }
        catch (error) {
            console.error("[Local Message Editor] Failed to start edit:", error);
            editingId = null;
        }
    };
    let icon;
    try {
        if (ActionSheetRow?.Icon) {
            icon = (React.createElement(ActionSheetRow.Icon, { source: getAssetIDByName("ic_edit_24px") }));
        }
    }
    catch {
        icon = undefined;
    }
    const row = (React.createElement(ActionSheetRow, { label: "Edit Locally", icon: icon, onPress: editLocally }));
    buttons.unshift(row);
}
export default {
    onLoad() {
        if (!ActionSheet) {
            console.error("[Local Message Editor] ActionSheet not found.");
            return;
        }
        if (!MessageActions?.editMessage) {
            console.error("[Local Message Editor] Message actions not found.");
            return;
        }
        /*
         * Add "Edit Locally" to the message
         * long-press menu.
         */
        patches.push(before("openLazy", ActionSheet, ([component, key, data]) => {
            if (key !==
                "MessageLongPressActionSheet") {
                return;
            }
            const message = data?.message;
            if (!message?.id) {
                return;
            }
            component?.then?.((instance) => {
                if (!instance)
                    return;
                const unpatch = after("default", instance, (_args, result) => {
                    setTimeout(() => {
                        try {
                            unpatch();
                        }
                        catch { }
                    }, 0);
                    const buttons = findInReactTree(result, (node) => Array.isArray(node) &&
                        node.some?.((item) => item
                            ?.type
                            ?.name ===
                            "ActionSheetRow"));
                    if (!buttons) {
                        return;
                    }
                    addButton(buttons, message);
                });
            });
        }));
        /*
         * Intercept the edit request.
         *
         * The edited content is sent to the
         * local Flux store instead of Discord.
         */
        patches.push(before("editMessage", MessageActions, (args) => {
            const [channelId, messageId, data,] = args;
            if (!editingId ||
                messageId !== editingId) {
                return;
            }
            const original = savedMessages.get(messageId);
            if (!original) {
                editingId = null;
                return;
            }
            const content = typeof data === "string"
                ? data
                : data?.content ?? "";
            try {
                FluxDispatcher.dispatch({
                    type: "MESSAGE_UPDATE",
                    message: {
                        ...original,
                        channel_id: channelId,
                        content,
                        edited_timestamp: null,
                    },
                    otherPluginBypass: true,
                });
                /*
                 * Stop the real Discord
                 * edit from being sent.
                 */
                return false;
            }
            catch (error) {
                console.error("[Local Message Editor] Failed to update message:", error);
                editingId = null;
            }
        }));
        /*
         * Reset editing state when the editor closes.
         */
        if (MessageActions?.endEditMessage) {
            patches.push(after("endEditMessage", MessageActions, () => {
                editingId = null;
            }));
        }
        console.log("[Local Message Editor] Loaded.");
    },
    onUnload() {
        for (const unpatch of patches) {
            try {
                unpatch();
            }
            catch { }
        }
        patches = [];
        savedMessages.clear();
        editingId = null;
        console.log("[Local Message Editor] Unloaded.");
    },
};
