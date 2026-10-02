# Компонент уведомлений Windows

Это отдельная программа Windows: установленный MSIX предоставляет app identity
и capability `userNotificationListener`. Portable Flux не получает это разрешение
сам и не читает внутреннюю базу уведомлений Windows.

Требуется Windows 10 2004 или новее, .NET SDK 8 и Windows SDK с MakeAppx.
На Windows выполните:

```powershell
powershell -NoProfile -File tools/windows-notification-bridge/build.ps1
```

`dotnet publish` проверяет C# и WinRT-проекции, `makeappx pack` проверяет manifest
и создаёт `out/Flux.NotificationBridge.msix`. Пакет пока не подписан и не
устанавливается автоматически. Его должен подписать владелец сертификатом с
Subject `CN=Flux`; затем сертификат должен быть доверенным на компьютерах
сотрудников. Приватный ключ не хранится в репозитории. Если используется другой
Subject, `Publisher` в manifest должен совпадать с ним. Для доменного выпуска
лучше использовать существующую политику доставки доверенных пакетов.

```powershell
# Здесь thumbprint — уже установленный сертификат владельца, а не новый ключ.
signtool sign /fd SHA256 /sha1 THUMBPRINT tools/windows-notification-bridge/out/Flux.NotificationBridge.msix
Add-AppxPackage tools/windows-notification-bridge/out/Flux.NotificationBridge.msix
```

В Flux команда «Подключить уведомления Windows» запускает этот установленный
компонент через Windows app activation. В его окне человек явно нажимает
«Разрешить передачу в Flux», после чего `RequestAccessAsync` спрашивает
разрешение Windows. Чтение начинается только при `Allowed` и включённой
локальной передаче. Отзыв Windows-разрешения, кнопка прекращения передачи и
закрытие окна очищают опубликованный снимок. Можно свернуть окно: Win32/WPF
процесс продолжает работать без приостановки UWP. Автозапуск и скрытый
запрос согласия не реализованы.

Источник — `UserNotificationListener.GetNotificationsAsync(Toast)` и
`NotificationChanged`. Каждые 10 секунд также проверяются разрешение и
коллекция. Не вызываются `RemoveNotification`, `ClearNotifications` или
активация уведомления. Flux показывает текст с источником «Windows»; чтение
в Flux не меняет уведомление в Windows. Полученные тексты не отправляются
на сервер и не попадают в диагностический журнал.

Компонент атомарно публикует UTF-8 JSON в своём
`ApplicationData.Current.LocalFolder/notifications.json`. Главный процесс Flux
находит PackageFamilyName только для установленного `Flux.NotificationBridge`
и читает только этот фиксированный файл LocalState. Renderer не передаёт пути.
Снимок ограничен 200 уведомлениями; главный процесс проверяет схему, длины,
дату, источник, наличие пакета и отсутствие junction в пути. Снимки старше
45 секунд, после отказа или без согласия не показываются.

Проверка на Windows обязательна: установка доверенного MSIX, запрос из
пользовательского окна, запрет и отзыв разрешения, получение уведомления из
другой программы, удаление его в центре Windows, сворачивание/закрытие
компонента, переход Flux между учётными записями. В Linux можно проверить
TypeScript-мост и содержимое manifest, но нельзя подтвердить API Windows
или сборку этого Windows-проекта.
