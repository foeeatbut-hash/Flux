// Контрольный расчёт «статистика числовых параметров» на Rust для Flux.
// Тот же расчёт, что в C, C++, Go, C#, Python и TypeScript (см. modules/fixtures/c/src/main.c).
// Без зависимостей и без WASI: у модуля нет ни одного импорта.
use std::cell::UnsafeCell;

struct Buffers {
    input: Vec<u8>,
    output: String,
}

// Расчёт идёт в одном потоке (Worker): общий буфер без синхронизации.
struct Shared(UnsafeCell<Buffers>);
unsafe impl Sync for Shared {}
static BUFFERS: Shared = Shared(UnsafeCell::new(Buffers { input: Vec::new(), output: String::new() }));

fn buffers() -> &'static mut Buffers {
    unsafe { &mut *BUFFERS.0.get() }
}

#[no_mangle]
pub extern "C" fn flux_alloc(size: i32) -> *mut u8 {
    let b = buffers();
    b.input = vec![0u8; size as usize];
    b.input.as_mut_ptr()
}

/// [+-]?(цифры[.цифры*]|.цифры)([eE][+-]?цифры)? — ровно то, что принимают все языки примера
fn is_number(s: &[u8]) -> bool {
    let digit = |k: usize| k < s.len() && s[k].is_ascii_digit();
    let (mut i, mut digits) = (0usize, 0usize);
    if i < s.len() && (s[i] == b'+' || s[i] == b'-') {
        i += 1;
    }
    while digit(i) {
        i += 1;
        digits += 1;
    }
    if i < s.len() && s[i] == b'.' {
        i += 1;
        while digit(i) {
            i += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return false;
    }
    if i < s.len() && (s[i] == b'e' || s[i] == b'E') {
        i += 1;
        if i < s.len() && (s[i] == b'+' || s[i] == b'-') {
            i += 1;
        }
        let mut exp_digits = 0;
        while digit(i) {
            i += 1;
            exp_digits += 1;
        }
        if exp_digits == 0 {
            return false;
        }
    }
    i == s.len()
}

/// `{}` у f64 печатает кратчайшую запись, которая читается обратно в то же число, но большие
/// значения пишет цифрами без порядка — для получателя это «целое больше 2^53». Договор Flux
/// требует для них запись с порядком (1e150): тогда это float64, а не потерянное целое.
fn num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() >= 9007199254740992.0 {
        format!("{:e}", v)
    } else {
        format!("{}", v)
    }
}

#[no_mangle]
pub extern "C" fn flux_run(ptr: i32, len: i32) -> i32 {
    let text = unsafe { std::slice::from_raw_parts(ptr as usize as *const u8, len as usize) };
    let key = b"\"value\":\"";
    let (mut count, mut sum, mut sumsq, mut min, mut max) = (0i64, 0f64, 0f64, 0f64, 0f64);
    let mut p = 0usize;
    while p + key.len() <= text.len() {
        if &text[p..p + key.len()] != key {
            p += 1;
            continue;
        }
        let start = p + key.len();
        let mut stop = start;
        while stop < text.len() && text[stop] != b'"' {
            stop += 1;
        }
        let item = &text[start..stop];
        if !item.is_empty() && item.len() < 64 && is_number(item) {
            if let Ok(v) = std::str::from_utf8(item).unwrap_or("").parse::<f64>() {
                if v.is_finite() {
                    if count == 0 {
                        min = v;
                        max = v;
                    }
                    if v < min {
                        min = v;
                    }
                    if v > max {
                        max = v;
                    }
                    sum += v;
                    sumsq += v * v;
                    count += 1;
                }
            }
        }
        p = stop;
    }
    let mean = if count > 0 { sum / count as f64 } else { 0.0 };
    let rms = if count > 0 { (sumsq / count as f64).sqrt() } else { 0.0 };
    if !sum.is_finite() || !mean.is_finite() || !rms.is_finite() {
        return -1;
    }
    let out = &mut buffers().output;
    *out = format!(
        "{{\"state\":{{}},\"calc\":{{\"out\":{{\"count\":{},\"sum\":{},\"mean\":{},\"rms\":{},\"min\":{},\"max\":{}}}}}}}",
        count, num(sum), num(mean), num(rms), num(min), num(max)
    );
    out.len() as i32
}

#[no_mangle]
pub extern "C" fn flux_output() -> *const u8 {
    buffers().output.as_ptr()
}
