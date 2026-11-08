// Контрольный расчёт «статистика числовых параметров» на Go (TinyGo) для Flux.
// Тот же расчёт, что в C, C++, Rust, C#, Python и TypeScript (см. modules/fixtures/c/src/main.c).
// Цель сборки wasm-unknown: без WASI и без JS-обёртки wasm_exec — у модуля нет импортов.
package main

import (
	"math"
	"strconv"
	"unsafe"
)

var input []byte
var output []byte

//export flux_alloc
func fluxAlloc(size int32) *byte {
	input = make([]byte, size)
	if size == 0 {
		return nil
	}
	return &input[0]
}

// [+-]?(цифры[.цифры*]|.цифры)([eE][+-]?цифры)? — ровно то, что принимают все языки примера
func isNumber(s []byte) bool {
	digit := func(k int) bool { return k < len(s) && s[k] >= '0' && s[k] <= '9' }
	i, digits := 0, 0
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		i++
	}
	for digit(i) {
		i++
		digits++
	}
	if i < len(s) && s[i] == '.' {
		i++
		for digit(i) {
			i++
			digits++
		}
	}
	if digits == 0 {
		return false
	}
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		i++
		if i < len(s) && (s[i] == '+' || s[i] == '-') {
			i++
		}
		expDigits := 0
		for digit(i) {
			i++
			expDigits++
		}
		if expDigits == 0 {
			return false
		}
	}
	return i == len(s)
}

func num(v float64) string { return strconv.FormatFloat(v, 'g', -1, 64) }

//export flux_run
func fluxRun(ptr uintptr, length int32) int32 {
	text := unsafe.Slice((*byte)(unsafe.Pointer(ptr)), int(length))
	key := []byte(`"value":"`)
	var count int64
	var sum, sumsq, min, max float64
	for p := 0; p+len(key) <= len(text); {
		if string(text[p:p+len(key)]) != string(key) {
			p++
			continue
		}
		start := p + len(key)
		stop := start
		for stop < len(text) && text[stop] != '"' {
			stop++
		}
		item := text[start:stop]
		if len(item) > 0 && len(item) < 64 && isNumber(item) {
			if v, err := strconv.ParseFloat(string(item), 64); err == nil && !math.IsInf(v, 0) && !math.IsNaN(v) {
				if count == 0 {
					min, max = v, v
				}
				if v < min {
					min = v
				}
				if v > max {
					max = v
				}
				sum += v
				sumsq += v * v
				count++
			}
		}
		p = stop
	}
	var mean, rms float64
	if count > 0 {
		mean = sum / float64(count)
		rms = math.Sqrt(sumsq / float64(count))
	}
	if math.IsInf(sum, 0) || math.IsNaN(sum) || math.IsInf(mean, 0) || math.IsInf(rms, 0) || math.IsNaN(rms) {
		return -1
	}
	output = []byte(`{"state":{},"calc":{"out":{"count":` + strconv.FormatInt(count, 10) +
		`,"sum":` + num(sum) + `,"mean":` + num(mean) + `,"rms":` + num(rms) +
		`,"min":` + num(min) + `,"max":` + num(max) + `}}}`)
	return int32(len(output))
}

//export flux_output
func fluxOutput() *byte {
	if len(output) == 0 {
		return nil
	}
	return &output[0]
}

func main() {}
