using System.IO;
using System.Text.Json;
using System.Threading;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using Windows.Storage;
using Windows.UI.Notifications;
using Windows.UI.Notifications.Management;

namespace Flux.NotificationBridge;

internal sealed record NotificationItem(string Id, string Source, string AppName, string Title, string Body, string CreatedAt);
internal sealed record Snapshot(int Schema, string Status, string UpdatedAt, NotificationItem[] Items);

internal static class Program
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindow(string? className, string title);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [STAThread]
    private static void Main()
    {
        // Один читатель на Windows-сеанс исключает гонку между копиями companion.
        using var singleton = new Mutex(true, @"Local\Flux.NotificationBridge", out bool created);
        if (!created)
        {
            IntPtr window = FindWindow(null, "Уведомления Windows в Flux");
            if (window != IntPtr.Zero) { ShowWindow(window, 9); SetForegroundWindow(window); }
            return;
        }
        var application = new Application();
        application.Run(new ConsentWindow());
    }
}

internal sealed class ConsentWindow : Window
{
    private readonly TextBlock status = new() { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 12, 0, 12) };
    private readonly Button consent = new() { Content = "Разрешить передачу в Flux", Padding = new Thickness(14, 8, 14, 8), Margin = new Thickness(0, 0, 8, 0) };
    private readonly Button stop = new() { Content = "Прекратить передачу", Padding = new Thickness(14, 8, 14, 8) };
    private readonly SemaphoreSlim writing = new(1, 1);
    private readonly SemaphoreSlim snapshotWriting = new(1, 1);
    private readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromSeconds(10) };
    private UserNotificationListener? listener;
    private ApplicationData? data;
    private bool closing;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public ConsentWindow()
    {
        Title = "Уведомления Windows в Flux";
        Width = 590; Height = 330; ResizeMode = ResizeMode.CanMinimize;
        var panel = new StackPanel { Margin = new Thickness(24) };
        panel.Children.Add(new TextBlock { FontSize = 22, Text = Title });
        panel.Children.Add(new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 14, 0, 0),
            Text = "С вашего согласия Flux будет показывать названия и текст уведомлений других программ Windows. Они хранятся локально и не отправляются на сервер. Оставьте это окно открытым или сверните его; закрытие прекращает передачу." });
        panel.Children.Add(status);
        var actions = new StackPanel { Orientation = Orientation.Horizontal };
        actions.Children.Add(consent); actions.Children.Add(stop); panel.Children.Add(actions);
        Content = panel;
        consent.Click += async (_, _) => await RequestConsent();
        stop.Click += async (_, _) => { if (data != null) data.LocalSettings.Values["sharingEnabled"] = false; await Write("consent-required", []); await Refresh(); };
        Loaded += async (_, _) => await Initialize();
        timer.Tick += async (_, _) => await Refresh();
        Closing += (_, _) => {
            closing = true; timer.Stop(); if (listener != null) listener.NotificationChanged -= Changed;
            if (data != null) Write("unavailable", []).GetAwaiter().GetResult();
        };
    }

    private async Task Initialize()
    {
        try
        {
            // ApplicationData требует установленный MSIX и его Windows app identity.
            data = ApplicationData.Current;
            listener = UserNotificationListener.Current;
            listener.NotificationChanged += Changed;
            await Refresh();
            timer.Start();
        }
        catch { status.Text = "Компонент должен быть установлен из подписанного MSIX. Запуск отдельного exe не даёт доступа к уведомлениям."; consent.IsEnabled = false; stop.IsEnabled = false; }
    }

    private async Task RequestConsent()
    {
        if (listener == null || data == null) return;
        consent.IsEnabled = false;
        try
        {
            // Только кнопка в окне вызывает запрос; чтение и фоновое обновление его не вызывают.
            var access = await listener.RequestAccessAsync();
            data.LocalSettings.Values["sharingEnabled"] = access == UserNotificationListenerAccessStatus.Allowed;
            await Refresh();
        }
        catch { await Write("unavailable", []); status.Text = "Windows не разрешила запрос доступа. Проверьте разрешения уведомлений для этого компонента."; }
        finally { consent.IsEnabled = true; }
    }

    private async void Changed(UserNotificationListener sender, UserNotificationChangedEventArgs args)
    {
        if (closing) return;
        try { await Dispatcher.InvokeAsync(Refresh).Task.Unwrap(); }
        catch (TaskCanceledException) { }
    }

    private async Task Refresh()
    {
        if (listener == null || data == null || closing || !await writing.WaitAsync(0)) return;
        try
        {
            var access = listener.GetAccessStatus();
            if (access != UserNotificationListenerAccessStatus.Allowed)
            {
                data.LocalSettings.Values["sharingEnabled"] = false;
                await Write(access == UserNotificationListenerAccessStatus.Denied ? "denied" : "consent-required", []);
                status.Text = access == UserNotificationListenerAccessStatus.Denied
                    ? "Windows запретила доступ. Измените разрешение компонента в параметрах Windows и повторите запрос."
                    : "Передача выключена. Нажмите «Разрешить передачу в Flux», чтобы запросить разрешение Windows.";
                return;
            }
            if (data.LocalSettings.Values["sharingEnabled"] is not bool enabled || !enabled)
            {
                await Write("consent-required", []);
                status.Text = "Передача в Flux выключена. Доступ Windows уже выдан, но для возобновления требуется ваше действие.";
                return;
            }
            var notifications = await listener.GetNotificationsAsync(NotificationKinds.Toast);
            // Разрешение могло быть отозвано, пока Windows возвращала коллекцию.
            if (listener.GetAccessStatus() != UserNotificationListenerAccessStatus.Allowed)
            { data.LocalSettings.Values["sharingEnabled"] = false; await Write("denied", []); return; }
            if (closing || data.LocalSettings.Values["sharingEnabled"] is not true)
            { await Write(closing ? "unavailable" : "consent-required", []); return; }
            var items = notifications.OrderByDescending(item => item.CreationTime).Take(200).Select(item =>
            {
                var binding = item.Notification.Visual.GetBinding(KnownNotificationBindings.ToastGeneric);
                var texts = binding?.GetTextElements().Select(text => text.Text ?? "").ToArray() ?? [];
                return new NotificationItem("win:" + item.Id, "windows", Limit(item.AppInfo.DisplayInfo.DisplayName, 256),
                    Limit(texts.FirstOrDefault() ?? "Уведомление Windows", 1024), Limit(string.Join("\n", texts.Skip(1)), 8192), item.CreationTime.ToUniversalTime().ToString("O"));
            }).ToArray();
            await Write("ready", items);
            status.Text = $"Передача включена. В центре Windows: {items.Length} уведомлений. Отзыв разрешения или закрытие компонента прекращает передачу.";
        }
        catch { await Write("unavailable", []); status.Text = "Windows временно не вернула уведомления. Компонент повторит чтение автоматически."; }
        finally { writing.Release(); }
    }

    private static string Limit(string value, int max) => value.Length <= max ? value : value[..max];

    private async Task Write(string state, NotificationItem[] items)
    {
        if (data == null) return;
        await snapshotWriting.WaitAsync().ConfigureAwait(false);
        string folder = data.LocalFolder.Path;
        string temporary = Path.Combine(folder, "notifications-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            string json = JsonSerializer.Serialize(new Snapshot(1, state, DateTimeOffset.UtcNow.ToString("O"), items), JsonOptions);
            await File.WriteAllTextAsync(temporary, json).ConfigureAwait(false);
            // Отзыв согласия имеет приоритет над снимком, который ещё писался.
            if (state == "ready" && (closing || data.LocalSettings.Values["sharingEnabled"] is not true
                || listener?.GetAccessStatus() != UserNotificationListenerAccessStatus.Allowed))
            {
                state = closing ? "unavailable" : "consent-required";
                json = JsonSerializer.Serialize(new Snapshot(1, state, DateTimeOffset.UtcNow.ToString("O"), []), JsonOptions);
                await File.WriteAllTextAsync(temporary, json).ConfigureAwait(false);
            }
            File.Move(temporary, Path.Combine(folder, "notifications.json"), true);
        }
        catch (IOException) { /* Старый снимок протухает в main; ошибка диска не возвращает согласие. */ }
        catch (UnauthorizedAccessException) { }
        finally { try { if (File.Exists(temporary)) File.Delete(temporary); } catch (IOException) { } catch (UnauthorizedAccessException) { } finally { snapshotWriting.Release(); } }
    }
}
