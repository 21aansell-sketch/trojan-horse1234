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

    function looksLikeRow(node) {
        if (!node || !React?.isValidElement?.(node)) return false;
        const p = node.props || {};
        const label = p.label ?? p.title ?? p.text;
        return typeof label === "string" && typeof p.onPress === "function";
    }

    function findRowArray(node, depth = 0) {
        if (depth > 20 || node == null) return null;
        if (Array.isArray(node)) {
            const rows = node.filter(looksLikeRow);
            if (rows.length >= 2) return node;
            for (const child of node) {
                const found = findRowArray(child, depth + 1);
                if (found) return found;
            }
            return null;
        }
        if (React?.isValidElement?.(node)) return findRowArray(node.props?.children, depth + 1);
        if (typeof node === "object") {
            if (node.props) return findRowArray(node.props.children, depth + 1);
            for (const key of Object.keys(node)) {
                if (key === "_owner" || key === "_store") continue;
                const found = findRowArray(node[key], depth + 1);
                if (found) return found;
            }
        }
        return null;
    }

    function addButton(result, message) {
        const current = getMessage(message);
        if (!current?.id || isOwnMessage(current)) return;

        const buttons = findRowArray(result);
        if (!buttons) {
            console.warn("[Local Message Editor] Could not find message action rows.");
            return;
        }

        if (buttons.some((button) => {
            const p = button?.props || {};
            return (p.label ?? p.title ?? p.text) === "Edit Locally";
        })) return;

        const template = buttons.find(looksLikeRow);
        if (!template) return;

        const editLocally = () => {
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

        const props = { ...(template.props || {}) };
        if ("label" in props) props.label = "Edit Locally";
        else if ("title" in props) props.title = "Edit Locally";
        else props.label = "Edit Locally";
        props.onPress = editLocally;
        try {
            props.icon = getAssetIDByName("ic_edit_24px");
        } catch {}

        const row = React.cloneElement(template, props);
        buttons.unshift(row);
    }

    return {
        onLoad() {
            if (!ActionSheet || !MessageActions?.editMessage) {
                console.error("[Local Message Editor] Required Discord modules not found.");
                return;
            }

            patches.push(before("openLazy", ActionSheet, ([component, key, data]) => {
                if (key !== "MessageLongPressActionSheet") return;
                const message = data?.message;
                if (!message?.id) return;

                // Kettu/Discord versions differ: openLazy may receive a promise,
                // a component, or a module object. Handle all three.
                const hook = (instance) => {
                    if (!instance) return;
                    const target = instance.default ? instance : { default: instance };
                    if (typeof target.default !== "function") return;
                    const unpatch = after("default", target, (_args, result) => {
                        try { addButton(result, message); }
                        catch (e) { console.error("[Local Message Editor] Menu patch failed:", e); }
                        setTimeout(() => { try { unpatch(); } catch {} }, 0);
                    });
                };

                if (component?.then) component.then(hook);
                else hook(component);
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
            console.log("[Local Message Editor] Loaded v2.");
        },
        onUnload() {
            for (const unpatch of patches) { try { unpatch(); } catch {} }
            patches = [];
            savedMessages.clear();
            editingId = null;
        },
    };
})()
