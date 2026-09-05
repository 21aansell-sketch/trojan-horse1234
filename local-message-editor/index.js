(function () {
    "use strict";

    const React = globalThis.React;
    const metro = vendetta.metro;
    const { before, after } = vendetta.patcher;
    const { getAssetIDByName } = vendetta.ui.assets;
    const { Forms } = vendetta.ui.components;

    const MessageStore = metro.findByStoreName("MessageStore");
    const UserStore = metro.findByStoreName("UserStore");
    const ActionSheet = metro.findByProps("openLazy", "hideActionSheet");
    const ActionSheetModule = metro.findByProps("ActionSheetRow") || {};
    const ActionSheetRow = ActionSheetModule.ActionSheetRow || Forms?.FormRow;
    const MessageActions = metro.findByProps("startEditMessage", "editMessage");

    const savedMessages = new Map();
    let patches = [];
    let editingId = null;

    function clone(message) {
        try { return JSON.parse(JSON.stringify(message)); }
        catch { return { ...message }; }
    }

    function getMessage(message) {
        try { return MessageStore?.getMessage(message.channel_id, message.id) ?? message; }
        catch { return message; }
    }

    function isOwnMessage(message) {
        try {
            const user = UserStore?.getCurrentUser?.();
            return !!(user?.id && message?.author?.id && user.id === message.author.id);
        } catch { return false; }
    }

    function typeName(node) {
        const t = node?.type;
        return String(t?.displayName || t?.name || t?.type?.displayName || t?.type?.name || "");
    }

    function isRowElement(node) {
        if (!React?.isValidElement?.(node)) return false;
        const name = typeName(node).toLowerCase();
        const p = node.props || {};
        return name.includes("actionsheetrow") || name.includes("formrow") ||
            (name.includes("row") && (typeof p.onPress === "function" || typeof p.label === "string" || typeof p.title === "string"));
    }

    function findRowArray(node, depth = 0, seen = new Set()) {
        if (depth > 25 || node == null) return null;
        if (typeof node === "object" && node !== null) {
            if (seen.has(node)) return null;
            seen.add(node);
        }

        if (Array.isArray(node)) {
            const rows = node.filter(isRowElement);
            if (rows.length >= 2) return node;
            for (const child of node) {
                const found = findRowArray(child, depth + 1, seen);
                if (found) return found;
            }
            return null;
        }

        if (React?.isValidElement?.(node)) {
            const found = findRowArray(node.props?.children, depth + 1, seen);
            if (found) return found;
        }

        if (typeof node === "object") {
            if (node.props) {
                const found = findRowArray(node.props.children, depth + 1, seen);
                if (found) return found;
            }
            for (const key of Object.keys(node)) {
                if (key === "_owner" || key === "_store") continue;
                const found = findRowArray(node[key], depth + 1, seen);
                if (found) return found;
            }
        }
        return null;
    }

    function extractMessage(data) {
        return data?.message || data?.targetMessage || data?.msg || data?.item?.message ||
            (data?.channel_id && data?.id ? data : null);
    }

    function makeEditHandler(current) {
        return () => {
            try {
                editingId = current.id;
                if (!savedMessages.has(current.id)) savedMessages.set(current.id, clone(current));
                ActionSheet?.hideActionSheet?.();
                MessageActions?.startEditMessage?.(current.channel_id, current.id, current.content ?? "");
            } catch (e) {
                console.error("[Local Message Editor] Failed to start edit:", e);
                editingId = null;
            }
        };
    }

    function addButton(result, message) {
        const current = getMessage(message);
        if (!current?.id || !current?.channel_id || isOwnMessage(current)) return false;

        const buttons = findRowArray(result);
        if (!buttons) {
            console.warn("[Local Message Editor] v3: no row array found in message action sheet");
            return false;
        }

        if (buttons.some((button) => {
            const p = button?.props || {};
            return String(p.label ?? p.title ?? p.text ?? "") === "Edit Locally";
        })) return true;

        const template = buttons.find(isRowElement);
        if (!template && !ActionSheetRow) return false;

        const editLocally = makeEditHandler(current);
        let row;

        try {
            if (template) {
                const p = { ...(template.props || {}) };
                if ("label" in p) p.label = "Edit Locally";
                else if ("title" in p) p.title = "Edit Locally";
                else if ("text" in p) p.text = "Edit Locally";
                else p.label = "Edit Locally";
                p.onPress = editLocally;
                try { p.icon = getAssetIDByName("ic_edit_24px"); } catch {}
                row = React.cloneElement(template, p);
            } else {
                const props = { label: "Edit Locally", onPress: editLocally };
                try { props.icon = getAssetIDByName("ic_edit_24px"); } catch {}
                row = React.createElement(ActionSheetRow, props);
            }
            buttons.unshift(row);
            console.log("[Local Message Editor] v3: inserted Edit Locally");
            return true;
        } catch (e) {
            console.error("[Local Message Editor] v3: failed to insert row", e);
            return false;
        }
    }

    return {
        onLoad() {
            if (!ActionSheet || !MessageActions?.editMessage) {
                console.error("[Local Message Editor] Required Discord modules not found.", {
                    ActionSheet: !!ActionSheet,
                    MessageActions: !!MessageActions,
                });
                return;
            }

            patches.push(before("openLazy", ActionSheet, ([component, key, data]) => {
                const message = extractMessage(data);
                const componentName = String(component?.displayName || component?.name || component?.default?.displayName || component?.default?.name || "");
                const isMessageSheet = key === "MessageLongPressActionSheet" ||
                    /message.*long.*press|long.*press.*message/i.test(componentName) || !!message;
                if (!isMessageSheet || !message?.id) return;

                const hook = (instance) => {
                    if (!instance) return;
                    const target = instance.default ? instance : { default: instance };
                    if (typeof target.default !== "function") return;

                    const unpatch = after("default", target, (_args, result) => {
                        try { addButton(result, message); }
                        catch (e) { console.error("[Local Message Editor] v3 menu patch failed:", e); }
                        setTimeout(() => { try { unpatch(); } catch {} }, 0);
                    });
                };

                try {
                    if (component?.then) component.then(hook);
                    else hook(component);
                } catch (e) {
                    console.error("[Local Message Editor] v3 failed to hook action sheet:", e);
                }
            }));

            patches.push(before("editMessage", MessageActions, (args) => {
                const [channelId, messageId, data] = args;
                if (!editingId || messageId !== editingId) return;
                const original = savedMessages.get(messageId);
                if (!original) { editingId = null; return; }
                const content = typeof data === "string" ? data : data?.content ?? "";
                try {
                    metro.common.FluxDispatcher.dispatch({
                        type: "MESSAGE_UPDATE",
                        message: { ...original, channel_id: channelId, content, edited_timestamp: null },
                        otherPluginBypass: true,
                    });
                    return false;
                } catch (e) {
                    console.error("[Local Message Editor] Failed to update message:", e);
                    editingId = null;
                }
            }));

            if (MessageActions?.endEditMessage) {
                patches.push(after("endEditMessage", MessageActions, () => { editingId = null; }));
            }

            console.log("[Local Message Editor] Loaded v3", {
                actionSheet: !!ActionSheet,
                actionSheetRow: !!ActionSheetRow,
                messageActions: !!MessageActions,
            });
        },
        onUnload() {
            for (const unpatch of patches) { try { unpatch(); } catch {} }
            patches = [];
            savedMessages.clear();
            editingId = null;
        },
    };
})()
