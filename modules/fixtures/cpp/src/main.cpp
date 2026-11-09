// Контрольный расчёт «статистика числовых параметров» на C++ для Flux.
// Тот же расчёт, что в C, Rust, Go, C#, Python и TypeScript (см. modules/fixtures/c/src/main.c);
// здесь — со стандартной библиотекой C++ (std::string, std::vector, std::from_chars не нужен:
// число читает strtod после проверки записи). Исключения и RTTI выключены сборкой.
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <string_view>
#include <vector>

#define EXPORT(name) __attribute__((export_name(name)))

namespace {

std::string input_buffer;
std::string output_buffer;

// [+-]?(цифры[.цифры*]|.цифры)([eE][+-]?цифры)?
bool is_number(std::string_view s) {
  size_t i = 0, digits = 0;
  auto digit = [&](size_t k) { return k < s.size() && s[k] >= '0' && s[k] <= '9'; };
  if (i < s.size() && (s[i] == '+' || s[i] == '-')) i++;
  while (digit(i)) { i++; digits++; }
  if (i < s.size() && s[i] == '.') {
    i++;
    while (digit(i)) { i++; digits++; }
  }
  if (digits == 0) return false;
  if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
    i++;
    if (i < s.size() && (s[i] == '+' || s[i] == '-')) i++;
    size_t exp_digits = 0;
    while (digit(i)) { i++; exp_digits++; }
    if (exp_digits == 0) return false;
  }
  return i == s.size();
}

struct Stats {
  long count = 0;
  double sum = 0, sumsq = 0, min = 0, max = 0;
  void add(double v) {
    if (count == 0) { min = v; max = v; }
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumsq += v * v;
    count++;
  }
};

std::string number(double v) {
  char tmp[40];
  std::snprintf(tmp, sizeof(tmp), "%.17g", v);
  return tmp;
}

}  // namespace

extern "C" {

// Без исключений libc++ всё равно ссылается на эти функции в new/delete (нехватка памяти).
// Исключений во Flux нет: нехватка памяти — ловушка, расчёт останавливается с кодом «сбой».
void* __cxa_allocate_exception(size_t) { __builtin_trap(); }
[[noreturn]] void __cxa_throw(void*, void*, void (*)(void*)) { __builtin_trap(); }

EXPORT("flux_alloc") void* flux_alloc(int size) {
  input_buffer.assign(static_cast<size_t>(size), '\0');
  return input_buffer.data();
}

EXPORT("flux_run") int flux_run(int ptr, int len) {
  std::string_view text(reinterpret_cast<const char*>(static_cast<size_t>(ptr)), static_cast<size_t>(len));
  constexpr std::string_view key = "\"value\":\"";
  Stats stats;
  for (size_t at = text.find(key); at != std::string_view::npos; at = text.find(key, at)) {
    size_t start = at + key.size();
    size_t stop = text.find('"', start);
    if (stop == std::string_view::npos) stop = text.size();
    std::string_view item = text.substr(start, stop - start);
    if (!item.empty() && item.size() < 64 && is_number(item)) {
      double v = std::strtod(std::string(item).c_str(), nullptr);
      if (std::isfinite(v)) stats.add(v);
    }
    at = stop;
  }
  double mean = stats.count ? stats.sum / static_cast<double>(stats.count) : 0;
  double rms = stats.count ? std::sqrt(stats.sumsq / static_cast<double>(stats.count)) : 0;
  if (!std::isfinite(stats.sum) || !std::isfinite(mean) || !std::isfinite(rms)) return -1;
  output_buffer = "{\"state\":{},\"calc\":{\"out\":{\"count\":" + std::to_string(stats.count)
    + ",\"sum\":" + number(stats.sum) + ",\"mean\":" + number(mean) + ",\"rms\":" + number(rms)
    + ",\"min\":" + number(stats.min) + ",\"max\":" + number(stats.max) + "}}}";
  return static_cast<int>(output_buffer.size());
}

EXPORT("flux_output") const char* flux_output() { return output_buffer.c_str(); }

}
