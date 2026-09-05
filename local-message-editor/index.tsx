import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";
import { before, after } from "@vendetta/patcher";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";
import { findInReactTree } from "@vendetta/utils";

type Message = {
    id: string;
    channel_id: string;
    content?: string;
    author?: {
        id: string;
    };
    [key: string]: any;
};

const PLUGIN_NAME = "Local Message Editor";

const LazyActionSheet = findByProps(
    "openLazy",
    "hideActionSheet",
);

const MessageStore = findByStoreName("MessageStore");
const UserStore = findByStoreName("UserStore");

const Messages = findByProps(
    "sendMessage",
    "startEditMessage",
    "editMessage",
);

const ActionSheetModule = findByProps("ActionSheetRow");

const ActionSheetRow =
    ActionSheetModule?.ActionSheetRow ??
    Forms.FormRow;

const originalMessages = new Map<string, Message>();

let patches: (() => void)[] = [];

let editingMessageId: string | null = null;

function cloneMessage(message: Message): Message {
    try {
        return JSON.parse(
            JSON.stringify(message),
        );
    } catch {
        return {
            ...message,
        };
    }
}

function getMessage(message: Message): Message {
    try {
        return (
            MessageStore?.getMessage(
                message.channel_id,
                message.id,
            ) ?? message
        );
    } catch {
        return message;
    }
}

function isOwnMessage(message: Message): boolean {
    try {
        const currentUser =
            UserStore?.getCurrentUser?.();

        return (
            !!currentUser?.id &&
            !!message?.author?.id &&
            currentUser.id === message.author.id
        );
    } catch {
        return false;
    }
}

function addEditButton(
    buttons: any[],
    message: Message,
) {
    if (!buttons || !message?.id) {
        return;
    }

    // Don't add the button twice.
    if (
        buttons.some(
            (button) =>
                button?.props?.label ===
                "Edit Locally",
        )
    ) {
        return;
    }

    const currentMessage =
        getMessage(message);

    // Don't add the button to our own messages.
    if (isOwnMessage(currentMessage)) {
        return;
    }

    const handleEdit = () => {
        try {
            editingMessageId =
                currentMessage.id;

            // Save the original message.
            if (
                !originalMessages.has(
                    currentMessage.id,
                )
            ) {
                originalMessages.set(
                    currentMessage.id,
                    cloneMessage(currentMessage),
                );
            }

            // Close the action sheet.
            LazyActionSheet?.hideActionSheet?.();

            // Open Discord's normal message editor.
            Messages?.startEditMessage?.(
                currentMessage.channel_id,
                currentMessage.id,
                currentMessage.content ?? "",
            );
        } catch (error) {
            console.error(
                `[${PLUGIN_NAME}] Failed to start edit:`,
                error,
            );

            editingMessageId = null;
        }
    };

    let icon;

    try {
        if (ActionSheetRow?.Icon) {
            icon = (
                <ActionSheetRow.Icon
                    source={getAssetIDByName(
                        "ic_edit_24px",
                    )}
                />
            );
        }
    } catch {
        icon = undefined;
    }

    const button = (
        <ActionSheetRow
            label="Edit Locally"
            icon={icon}
            onPress={handleEdit}
        />
    );

    // Put the button near the other message actions.
    const unreadIndex =
        buttons.findIndex(
            (button) =>
                button?.props?.message
                    ?.toString?.() ===
                "MARK_UNREAD",
        );

    const position =
        unreadIndex >= 0
            ? unreadIndex
            : 0;

    buttons.splice(
        position,
        0,
        button,
    );
}

export default {
    onLoad() {
        console.log(
            `[${PLUGIN_NAME}] Loading...`,
        );

        // Check required modules.
        if (!LazyActionSheet) {
            console.error(
                `[${PLUGIN_NAME}] Action sheet module not found.`,
            );
            return;
        }

        if (!Messages) {
            console.error(
                `[${PLUGIN_NAME}] Message module not found.`,
            );
            return;
        }

        // Message long-press menu.
        patches.push(
            before(
                "openLazy",
                LazyActionSheet,
                ([component, key, data]) => {
                    if (
                        key !==
                        "MessageLongPressActionSheet"
                    ) {
                        return;
                    }

                    const message =
                        data?.message;

                    if (!message?.id) {
                        return;
                    }

                    component?.then?.(
                        (instance: any) => {
                            if (!instance) {
                                return;
                            }

                            const unpatch =
                                after(
                                    "default",
                                    instance,
                                    (
                                        _args,
                                        result,
                                    ) => {
                                        // Remove the temporary patch.
                                        setTimeout(
                                            () => {
                                                try {
                                                    unpatch();
                                                } catch {}
                                            },
                                            0,
                                        );

                                        // Find the action-sheet buttons.
                                        const buttons =
                                            findInReactTree(
                                                result,
                                                (
                                                    node: any,
                                                ) =>
                                                    Array.isArray(
                                                        node,
                                                    ) &&
                                                    node.some?.(
                                                        (
                                                            item: any,
                                                        ) =>
                                                            item
                                                                ?.type
                                                                ?.name ===
                                                            "ActionSheetRow",
                                                    ),
                                            );

                                        if (
                                            !buttons
                                        ) {
                                            return;
                                        }

                                        addEditButton(
                                            buttons,
                                            message,
                                        );
                                    },
                                );
                        },
                    );
                },
            ),
        );

        // Intercept editMessage.
        patches.push(
            before(
                "editMessage",
                Messages,
                (args: any[]) => {
                    const [
                        channelId,
                        messageId,
                        newMessage,
                    ] = args;

                    // Ignore normal Discord edits.
                    if (
                        !editingMessageId ||
                        messageId !==
                            editingMessageId
                    ) {
                        return;
                    }

                    const original =
                        originalMessages.get(
                            messageId,
                        );

                    if (!original) {
                        editingMessageId =
                            null;
                        return;
                    }

                    const content =
                        typeof newMessage ===
                        "string"
                            ? newMessage
                            : newMessage
                                  ?.content ??
                              "";

                    try {
                        // Update only the local message store.
                        FluxDispatcher.dispatch({
                            type:
                                "MESSAGE_UPDATE",

                            message: {
                                ...original,
                                channel_id:
                                    channelId,
                                content,

                                // Don't show the normal edited marker.
                                edited_timestamp:
                                    null,
                            },

                            // Prevent other plugins from treating
                            // this as a normal Discord edit.
                            otherPluginBypass:
                                true,
                        });

                        // Prevent Discord from sending the edit.
                        return false;
                    } catch (error) {
                        console.error(
                            `[${PLUGIN_NAME}] Failed to apply local edit:`,
                            error,
                        );

                        editingMessageId =
                            null;
                    }
                },
            ),
        );

        // Reset editing state when editing ends.
        if (
            Messages?.endEditMessage
        ) {
            patches.push(
                after(
                    "endEditMessage",
                    Messages,
                    () => {
                        editingMessageId =
                            null;
                    },
                ),
            );
        }

        console.log(
            `[${PLUGIN_NAME}] Loaded successfully.`,
        );
    },

    onUnload() {
        console.log(
            `[${PLUGIN_NAME}] Unloading...`,
        );

        // Remove all patches.
        for (
            const unpatch of patches
        ) {
            try {
                unpatch();
            } catch {}
        }

        patches = [];

        // Clear local state.
        originalMessages.clear();

        editingMessageId = null;

        console.log(
            `[${PLUGIN_NAME}] Unloaded.`,
        );
    },
};
