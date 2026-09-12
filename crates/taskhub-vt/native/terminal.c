#include <ghostty/vt.h>

// Keep upstream enum/layout details on the C side of the Rust boundary. These
// functions use the exact renderer revision; snapshots are not a stable disk ABI.
void *taskhub_vt_new(uint16_t cols, uint16_t rows) {
    GhosttyTerminal terminal = NULL;
    if (ghostty_terminal_new(NULL, &terminal, cols, rows) != GHOSTTY_SUCCESS) return NULL;
    const size_t continuation = 1024 * 1024;
    const size_t scrollback = 8 * 1024 * 1024;
    if (ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_CONTINUATION_MAX_BYTES, &continuation) != GHOSTTY_SUCCESS ||
        ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES, &scrollback) != GHOSTTY_SUCCESS) {
        ghostty_terminal_free(terminal);
        return NULL;
    }
    return terminal;
}

void taskhub_vt_free(void *terminal) { ghostty_terminal_free(terminal); }
void taskhub_vt_feed(void *terminal, const uint8_t *bytes, size_t len) {
    ghostty_terminal_vt_write(terminal, bytes, len);
}
int taskhub_vt_resize(void *terminal, uint16_t cols, uint16_t rows) {
    return ghostty_terminal_resize(terminal, cols, rows, 0, 0);
}
int taskhub_vt_snapshot(void *terminal, GhosttyWriterFn write, void *userdata) {
    return ghostty_snapshot_encode(terminal, (GhosttyWriter){ .write = write, .userdata = userdata });
}
void *taskhub_vt_restore(const uint8_t *bytes, size_t len) {
    GhosttySnapshotDecoder decoder = NULL;
    GhosttyTerminal terminal = NULL;
    if (ghostty_snapshot_decoder_new_buf(NULL, &decoder, bytes, len) != GHOSTTY_SUCCESS) return NULL;
    size_t continuation = 1024 * 1024;
    bool retain = true;
    size_t consumed = 0;
    bool valid = ghostty_snapshot_decoder_set(decoder, GHOSTTY_SNAPSHOT_DECODER_OPT_MAX_CONTINUATION_BYTES, &continuation) == GHOSTTY_SUCCESS &&
        ghostty_snapshot_decoder_set(decoder, GHOSTTY_SNAPSHOT_DECODER_OPT_RETAIN_CONTINUATION, &retain) == GHOSTTY_SUCCESS &&
        ghostty_snapshot_decoder_decode(decoder, &terminal) == GHOSTTY_SUCCESS &&
        ghostty_snapshot_decoder_get(decoder, GHOSTTY_SNAPSHOT_DECODER_DATA_SOURCE_OFFSET, &consumed) == GHOSTTY_SUCCESS && consumed == len;
    ghostty_snapshot_decoder_free(decoder);
    if (!valid) { ghostty_terminal_free(terminal); return NULL; }
    return terminal;
}
int taskhub_vt_format(void *terminal, GhosttyWriterFn write, void *userdata) {
    GhosttyFormatter formatter = NULL;
    GhosttyFormatterTerminalOptions options = {
        .size = sizeof(options), .emit = GHOSTTY_FORMATTER_FORMAT_VT, .unwrap = false, .trim = false,
        .extra = {
            .size = sizeof(GhosttyFormatterTerminalExtra), .palette = true, .modes = true,
            .scrolling_region = true, .tabstops = true, .pwd = true, .keyboard = true,
            .screen = { .size = sizeof(GhosttyFormatterScreenExtra), .cursor = true, .style = true,
                .hyperlink = true, .protection = true, .kitty_keyboard = true, .charsets = true },
        },
    };
    int result = ghostty_formatter_terminal_new(NULL, &formatter, terminal, options);
    if (result == GHOSTTY_SUCCESS) result = ghostty_formatter_format(formatter, (GhosttyWriter){ .write = write, .userdata = userdata });
    ghostty_formatter_free(formatter);
    return result;
}
int taskhub_vt_cursor(void *terminal, uint16_t *x, uint16_t *y) {
    int result = ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_CURSOR_X, x);
    if (result == GHOSTTY_SUCCESS) result = ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_CURSOR_Y, y);
    return result;
}
int taskhub_vt_mode(void *terminal, uint16_t number, bool ansi, bool *value) {
    GhosttyTerminalModeConfig mode = { .mode = ghostty_mode_new(number, ansi) };
    int result = ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_MODE, &mode);
    if (result == GHOSTTY_SUCCESS) *value = mode.value;
    return result;
}
