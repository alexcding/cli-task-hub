// C ABI of crates/taskhub-backend (src/ffi.rs). Keep in sync by hand.
#ifndef TASKHUB_BACKEND_H
#define TASKHUB_BACKEND_H
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct TaskHubBackend TaskHubBackend;

typedef void (*taskhub_response_callback)(void *ctx, int32_t status, const char *content_type, const uint8_t *body, size_t len);
typedef void (*taskhub_event_callback)(void *ctx, const uint8_t *json, size_t len);
typedef void (*taskhub_drop_callback)(void *ctx);

int32_t taskhub_backend_start(const char *data_dir, int32_t packaged, const char *instance_id, TaskHubBackend **out, char **error);
uint16_t taskhub_backend_port(const TaskHubBackend *backend);
void taskhub_backend_request(const TaskHubBackend *backend, const char *method, const char *path_and_query, const uint8_t *body, size_t body_len, void *ctx, taskhub_response_callback callback);
uint64_t taskhub_backend_subscribe(const TaskHubBackend *backend, void *ctx, taskhub_event_callback callback, taskhub_drop_callback dropped);
void taskhub_backend_unsubscribe(const TaskHubBackend *backend, uint64_t id);
void taskhub_backend_stop(TaskHubBackend *backend);
void taskhub_string_free(char *value);

#ifdef __cplusplus
}
#endif
#endif
