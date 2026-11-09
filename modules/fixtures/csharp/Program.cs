// Контрольный расчёт «статистика числовых параметров» на C# (.NET 8, WASI) для Flux.
// Тот же расчёт, что в C, C++, Rust, Go, Python и TypeScript (см. modules/fixtures/c/src/main.c).
//
// Договор «WASI-команда» (modules/engine/wasm.ts): вход — JSON на стандартном вводе,
// выход — JSON на стандартном выводе, один запуск `_start` на один расчёт. Так работает
// .NET для WASI: экспортов своих функций он не даёт, зато вход и выход через stdin/stdout
// есть в любом языке с поддержкой WASI.
using System;
using System.Globalization;
using System.IO;
using System.Text;

public static class Stats
{
    static bool IsNumber(string s)
    {
        int i = 0, digits = 0, n = s.Length;
        bool Digit(int k) => k < n && s[k] >= '0' && s[k] <= '9';
        if (i < n && (s[i] == '+' || s[i] == '-')) i++;
        while (Digit(i)) { i++; digits++; }
        if (i < n && s[i] == '.')
        {
            i++;
            while (Digit(i)) { i++; digits++; }
        }
        if (digits == 0) return false;
        if (i < n && (s[i] == 'e' || s[i] == 'E'))
        {
            i++;
            if (i < n && (s[i] == '+' || s[i] == '-')) i++;
            int exp = 0;
            while (Digit(i)) { i++; exp++; }
            if (exp == 0) return false;
        }
        return i == n;
    }

    static string Num(double v) => v.ToString("R", CultureInfo.InvariantCulture);

    public static int Main()
    {
        string text = Console.In.ReadToEnd();
        const string key = "\"value\":\"";
        long count = 0;
        double sum = 0, sumsq = 0, min = 0, max = 0;
        for (int p = 0; p + key.Length <= text.Length;)
        {
            if (string.CompareOrdinal(text, p, key, 0, key.Length) != 0) { p++; continue; }
            int start = p + key.Length;
            int stop = text.IndexOf('"', start);
            if (stop < 0) stop = text.Length;
            string item = text.Substring(start, stop - start);
            if (item.Length > 0 && item.Length < 64 && IsNumber(item))
            {
                double v = double.Parse(item, NumberStyles.Float, CultureInfo.InvariantCulture);
                if (!double.IsInfinity(v) && !double.IsNaN(v))
                {
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
        double mean = count > 0 ? sum / count : 0;
        double rms = count > 0 ? Math.Sqrt(sumsq / count) : 0;
        if (double.IsInfinity(sum) || double.IsNaN(sum) || double.IsInfinity(mean) || double.IsInfinity(rms) || double.IsNaN(rms)) return 1;
        var o = new StringBuilder();
        o.Append("{\"state\":{},\"calc\":{\"out\":{\"count\":").Append(count.ToString(CultureInfo.InvariantCulture))
         .Append(",\"sum\":").Append(Num(sum)).Append(",\"mean\":").Append(Num(mean)).Append(",\"rms\":").Append(Num(rms))
         .Append(",\"min\":").Append(Num(min)).Append(",\"max\":").Append(Num(max)).Append("}}}");
        Console.Out.Write(o.ToString());
        Console.Out.Flush();
        return 0;
    }
}
