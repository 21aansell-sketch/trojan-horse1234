(() => {
    "use strict";

    const vendettaApi = globalThis.vendetta;
    const React = globalThis.React;

    if (!vendettaApi || !React) {
        console.error("[Local Message Editor] Kettu/Vendetta runtime not available.");
        return {
            onLoad() {},
            onUnload() {},
        };
    }

    const metro = vendettaApi.metro;
    const patcher = vendettaApi.patcher;
    const assets = vendettaApi.ui?.assets;
    const components = vendettaApi.ui?.components;

    const { before, after } = patcher || {};
    const { getAssetIDByName } = assets || {};
    const Forms = components?.Forms;

    const patches = [];
    const localEdits = new Map();
    let editingMessageId = null;

    function findByStoreName(name) {
        try {
            return metro?.findByStoreName?.(name);
        } catch {
            return undefined;
        }
    }

    function findByProps(...props) {
        try {
            return metro?.findByProps?.(...props);
        } catch {
            return undefined;
        }
    }

    function findStore(name, ...fallbackProps) {
        return findByStoreName(name) || findByProps(...fallbackProps);
    }

    const MessageStore = findStore("MessageStore", "getMessage", "getMessages");
    const UserStore = findStore("UserStore", "getCurrentUser", "getUser");

    const ActionSheet =
        findByProps("openLazy", "hideActionSheet") ||
        findByProps("openLazy");

    const ActionSheetModule =
        findByProps("ActionSheetRow") || {};

    const ActionSheetRow =
        ActionSheetModule.ActionSheetRow ||
        Forms?.FormRow;

    // Prefer the exact pair used by the Discord edit flow, but tolerate
    // changes in the surrounding module export shape.
    const MessageActions =
        findByProps("startEditMessage", "editMessage") ||
        findByProps("startEditMessage") ||
        findByProps("editMessage");

    function safeClone(value) {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return value && typeof value === "object" ? { ...value } : value;
        }
    }

    function getMessage(message) {
        if (!message?.channel_id || !message?.id) return message;

        try {
            return MessageStore?.getMessage?.(
                message.channel_id,
                message.id
            ) ?? message;
        } catch {
            return message;
        }
    }

    function isOwnMessage(message) {
        try {
            const user = UserStore?.getCurrentUser?.();
            return Boolean(
                user?.id &&
                message?.author?.id &&
                String(user.id) === String(message.author.id)
            );
        } catch {
            return false;
        }
    }

    function getTypeName(node) {
        const type = node?.type;
        return String(
            type?.displayName ||
            type?.name ||
            type?.type?.displayName ||
            type?.type?.name ||
            ""
        );
    }

    function isActionRow(node) {
        if (!React.isValidElement?.(node)) return false;

        const name = getTypeName(node).toLowerCase();
        const props = node.props || {};

        return (
            name.includes("actionsheetrow") ||
            name.includes("formrow") ||
            (
                name.includes("row") &&
                (
                    typeof props.onPress === "function" ||
                    typeof props.label === "string" ||
                    typeof props.title === "string"
                )
            )
        );
    }

    function findRowArray(node, depth = 0, seen = new Set()) {
        if (node == null || depth > 30) return null;

        if (typeof node === "object") {
            if (seen.has(node)) return null;
            seen.add(node);
        }

        if (Array.isArray(node)) {
            if (node.filter(isActionRow).length >= 2) {
                return node;
            }

            for (const child of node) {
                const result = findRowArray(child, depth + 1, seen);
                if (result) return result;
            }

            return null;
        }

        if (React.isValidElement?.(node)) {
            return findRowArray(node.props?.children, depth + 1, seen);
        }

        if (typeof node === "object") {
            if (node.props) {
                const result = findRowArray(
                    node.props.children,
                    depth + 1,
                    seen
                );
                if (result) return result;
            }

            for (const key of Object.keys(node)) {
                if (key === "_owner" || key === "_store") continue;

                const result = findRowArray(
                    node[key],
                    depth + 1,
                    seen
                );

                if (result) return result;
            }
        }

        return null;
    }

    function extractMessage(data) {
        return (
            data?.message ||
            data?.targetMessage ||
            data?.msg ||
            data?.item?.message ||
            (data?.channel_id && data?.id ? data : null)
        );
    }

    function setRowLabel(props, label) {
        if ("label" in props) props.label = label;
        else if ("title" in props) props.title = label;
        else if ("text" in props) props.text = label;
        else props.label = label;
    }

    function makeEditHandler(message) {
        return () => {
            try {
                const current = getMessage(message);

                if (!current?.id || !current?.channel_id) return;

                editingMessageId = current.id;

                if (!localEdits.has(current.id)) {
                    localEdits.set(current.id, safeClone(current));
                }

                ActionSheet?.hideActionSheet?.();

                const startEdit = MessageActions?.startEditMessage;
                if (typeof startEdit !== "function") {
                    throw new Error("startEditMessage was not found");
                }

                startEdit(
                    current.channel_id,
                    current.id,
                    current.content ?? ""
                );
            } catch (error) {
                console.error(
                    "[Local Message Editor] Could not start local edit:",
                    error
                );
                editingMessageId = null;
            }
        };
    }

    function addEditLocallyButton(result, message) {
        const current = getMessage(message);

        if (
            !current?.id ||
            !current?.channel_id ||
            isOwnMessage(current)
        ) {
            return false;
        }

        const rows = findRowArray(result);

        if (!rows) {
            console.warn(
                "[Local Message Editor] Could not locate message action rows."
            );
            return false;
        }

        if (
            rows.some((row) => {
                const props = row?.props || {};
                const label =
                    props.label ??
                    props.title ??
                    props.text ??
                    "";

                return String(label) === "Edit Locally";
            })
        ) {
            return true;
        }

        const template = rows.find(isActionRow);

        if (!template && !ActionSheetRow) {
            console.warn(
                "[Local Message Editor] ActionSheetRow/FormRow not found."
            );
            return false;
        }

        const onPress = makeEditHandler(current);
        let row;

        try {
            if (template) {
                const props = { ...(template.props || {}) };

                setRowLabel(props, "Edit Locally");
                props.onPress = onPress;

                if (typeof getAssetIDByName === "function") {
                    try {
                        props.icon = getAssetIDByName("ic_edit_24px");
                    } catch {}
                }

                row = React.cloneElement(template, props);
            } else {
                const props = {
                    label: "Edit Locally",
                    onPress,
                };

                if (typeof getAssetIDByName === "function") {
                    try {
                        props.icon = getAssetIDByName("ic_edit_24px");
                    } catch {}
                }

                row = React.createElement(ActionSheetRow, props);
            }

            rows.unshift(row);
            return true;
        } catch (error) {
            console.error(
                "[Local Message Editor] Failed to add menu item:",
                error
            );
            return false;
        }
    }

    function patchActionSheet() {
        if (
            typeof before !== "function" ||
            !ActionSheet ||
            typeof ActionSheet.openLazy !== "function"
        ) {
            console.error(
                "[Local Message Editor] ActionSheet.openLazy is unavailable."
            );
            return;
        }

        const unpatch = before(
            "openLazy",
            ActionSheet,
            ([component, key, data]) => {
                const message = extractMessage(data);

                if (!message?.id || !message?.channel_id) return;

                const componentName = String(
                    component?.displayName ||
                    component?.name ||
                    component?.default?.displayName ||
                    component?.default?.name ||
                    ""
                );

                const isMessageSheet =
                    key === "MessageLongPressActionSheet" ||
                    /message.*long.*press|long.*press.*message/i.test(
                        componentName
                    ) ||
                    Boolean(message);

                if (!isMessageSheet) return;

                const hook = (loadedComponent) => {
                    if (!loadedComponent) return;

                    const target =
                        loadedComponent.default
                            ? loadedComponent
                            : { default: loadedComponent };

                    if (typeof target.default !== "function") return;

                    let menuUnpatch;

                    try {
                        menuUnpatch = after(
                            "default",
                            target,
                            (_args, result) => {
                                try {
                                    addEditLocallyButton(result, message);
                                } catch (error) {
                                    console.error(
                                        "[Local Message Editor] Action-sheet patch failed:",
                                        error
                                    );
                                }

                                queueMicrotask(() => {
                                    try {
                                        menuUnpatch?.();
                                    } catch {}
                                });
                            }
                        );
                    } catch (error) {
                        console.error(
                            "[Local Message Editor] Could not patch action-sheet component:",
                            error
                        );
                    }
                };

                try {
                    if (component?.then) {
                        component.then(hook);
                    } else {
                        hook(component);
                    }
                } catch (error) {
                    console.error(
                        "[Local Message Editor] Could not load action-sheet component:",
                        error
                    );
                }
            }
        );

        patches.push(unpatch);
    }

    function patchEditAction() {
        if (
            typeof before !== "function" ||
            !MessageActions ||
            typeof MessageActions.editMessage !== "function"
        ) {
            console.error(
                "[Local Message Editor] MessageActions.editMessage is unavailable."
            );
            return;
        }

        const unpatch = before(
            "editMessage",
            MessageActions,
            (args) => {
                const [channelId, messageId, data] = args;

                if (
                    !editingMessageId ||
                    String(messageId) !== String(editingMessageId)
                ) {
                    return;
                }

                const original = localEdits.get(messageId);

                if (!original) {
                    editingMessageId = null;
                    return;
                }

                const content =
                    typeof data === "string"
                        ? data
                        : data?.content ?? "";

                try {
                    const dispatcher =
                        metro?.common?.FluxDispatcher;

                    if (!dispatcher?.dispatch) {
                        throw new Error(
                            "FluxDispatcher.dispatch was not found"
                        );
                    }

                    dispatcher.dispatch({
                        type: "MESSAGE_UPDATE",
                        message: {
                            ...original,
                            channel_id: channelId,
                            content,
                            edited_timestamp: null,
                        },
                        otherPluginBypass: true,
                    });

                    // Returning false prevents Discord's real edit request.
                    return false;
                } catch (error) {
                    console.error(
                        "[Local Message Editor] Local message update failed:",
                        error
                    );
                    editingMessageId = null;
                }
            }
        );

        patches.push(unpatch);
    }

    function patchEndEdit() {
        if (
            typeof after !== "function" ||
            !MessageActions ||
            typeof MessageActions.endEditMessage !== "function"
        ) {
            return;
        }

        const unpatch = after(
            "endEditMessage",
            MessageActions,
            () => {
                editingMessageId = null;
            }
        );

        patches.push(unpatch);
    }

    return {
        onLoad() {
            console.log("[Local Message Editor] Loading...");

            if (!MessageActions) {
                console.error(
                    "[Local Message Editor] MessageActions module was not found."
                );
                return;
            }

            patchActionSheet();
            patchEditAction();
            patchEndEdit();

            console.log("[Local Message Editor] Loaded.", {
                messageStore: Boolean(MessageStore),
                userStore: Boolean(UserStore),
                actionSheet: Boolean(ActionSheet),
                actionSheetRow: Boolean(ActionSheetRow),
                messageActions: Boolean(MessageActions),
                startEditMessage:
                    typeof MessageActions.startEditMessage === "function",
                editMessage:
                    typeof MessageActions.editMessage === "function",
                endEditMessage:
                    typeof MessageActions.endEditMessage === "function",
            });
        },

        onUnload() {
            for (const unpatch of patches.splice(0)) {
                try {
                    unpatch?.();
                } catch {}
            }

            localEdits.clear();
            editingMessageId = null;

            console.log("[Local Message Editor] Unloaded.");
        },
    };
})()
