/*
 * Контрольный расчёт «статистика числовых параметров» на C для Flux.
 *
 * Читает из входного JSON значения вида "value":"<число>" (так оболочка
 * передаёт параметры оборудования) и отдаёт count, sum, mean, rms, min, max.
 * Те же числа, бит в бит, считают версии на TypeScript, Python, C++, Rust,
 * Go и C#: сложение по порядку, корень — один IEEE-корень, чтение числа —
 * корректно округляющее.
 *
 * Договор Flux для .wasm (modules/engine/wasm.ts):
 *   flux_alloc(n)       -> адрес буфера под вход
 *   flux_run(ptr, len)  -> длина выхода или отрицательный код ошибки
 *   flux_output()       -> адрес выхода
 * Ни сети, ни часов, ни случайности, ни файлов: из WASI нужен только _initialize.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define EXPORT(name) __attribute__((export_name(name)))

static char *input_buffer = NULL;
static char output_buffer[2048];

EXPORT("flux_alloc") void *flux_alloc(int size) {
  free(input_buffer);
  input_buffer = (char *)malloc((size_t)size + 1);
  return input_buffer;
}

/* [+-]?(цифры[.цифры*]|.цифры)([eE][+-]?цифры)? — ровно то, что принимают все языки примера */
static int is_number(const char *s, size_t n) {
  size_t i = 0, digits = 0;
  if (i < n && (s[i] == '+' || s[i] == '-')) i++;
  while (i < n && s[i] >= '0' && s[i] <= '9') { i++; digits++; }
  if (i < n && s[i] == '.') {
    i++;
    while (i < n && s[i] >= '0' && s[i] <= '9') { i++; digits++; }
  }
  if (digits == 0) return 0;
  if (i < n && (s[i] == 'e' || s[i] == 'E')) {
    i++;
    if (i < n && (s[i] == '+' || s[i] == '-')) i++;
    size_t exp_digits = 0;
    while (i < n && s[i] >= '0' && s[i] <= '9') { i++; exp_digits++; }
    if (exp_digits == 0) return 0;
  }
  return i == n;
}

EXPORT("flux_run") int flux_run(int ptr, int len) {
  const char *text = (const char *)(size_t)ptr;
  const char *end = text + len;
  const char key[] = "\"value\":\"";
  const size_t key_len = sizeof(key) - 1;
  long count = 0;
  double sum = 0, sumsq = 0, min = 0, max = 0;
  for (const char *p = text; p + key_len <= end;) {
    if (memcmp(p, key, key_len) != 0) { p++; continue; }
    const char *start = p + key_len, *stop = start;
    while (stop < end && *stop != '"') stop++;
    size_t n = (size_t)(stop - start);
    if (n > 0 && n < 64 && is_number(start, n)) {
      char tmp[64];
      memcpy(tmp, start, n);
      tmp[n] = 0;
      double v = strtod(tmp, NULL);
      if (isfinite(v)) {
        if (count == 0) { min = v; max = v; }
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
        sumsq += v * v;
        count++;
      }
    }
    p = stop;
  }
  double mean = count ? sum / (double)count : 0;
  double rms = count ? sqrt(sumsq / (double)count) : 0;
  if (!isfinite(sum) || !isfinite(mean) || !isfinite(rms)) return -1;
  int written = snprintf(output_buffer, sizeof(output_buffer),
    "{\"state\":{},\"calc\":{\"out\":{\"count\":%ld,\"sum\":%.17g,\"mean\":%.17g,\"rms\":%.17g,\"min\":%.17g,\"max\":%.17g}}}",
    count, sum, mean, rms, min, max);
  return written;
}

EXPORT("flux_output") const char *flux_output(void) { return output_buffer; }
