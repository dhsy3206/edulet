// State shared between the 불러오기 dialog (views/backup-dialog.js) and the live board connection (lib/board-controller.js).
//
// When a restore finishes the server sends every open board an SSE `reset` event, and a board that receives it reloads its page.
// The tab that STARTED the restore must not do that: its own dialog is about to show the result and then moves on by itself.
// `restoring` is true from just before the restore request until that tab navigates away (or the request fails).
export const backupState = { restoring: false };
