/**
 * Нативный помощник файлов Проводника: миниатюры, Быстрый доступ, облачные
 * корни, «Открыть с помощью», классическое меню, корзина Windows.
 *
 * Тот же приём, что у помощника рабочего стола (nativeDesktopSource.ts):
 * фиксированный код C#, собираемый Add-Type в Windows PowerShell, без данных
 * renderer. Отличие одно, и оно вынужденное: рабочий стол читается раз в
 * несколько секунд и запускается заново, а миниатюр нужны десятки подряд, и
 * компиляция C# на каждую (секунды) делала бы сетку значков непригодной. Поэтому
 * здесь процесс долгоживущий: компилируется один раз и обслуживает запросы,
 * по строке JSON на запрос (см. nativeShellHost.ts).
 *
 * Код не выполняется в Linux; на CI он проходит сборку и проверки на настоящей
 * Windows (scripts/test-windows-files-native.ts).
 */
export const NATIVE_SHELL_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32;

public static class FluxShellFiles {
  public static string Stage = "initialize";

  // ---------------------------------------------------------------- COM
  [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; }
  [StructLayout(LayoutKind.Sequential)] public struct BitmapHeader {
    public uint size; public int width, height; public ushort planes, bits;
    public uint compression, imageSize; public int xPixels, yPixels; public uint used, important;
  }
  [StructLayout(LayoutKind.Sequential)] public struct BitmapInfo { public BitmapHeader header; public uint color; }
  [StructLayout(LayoutKind.Sequential, Pack=4)] public struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Sequential)] public struct MenuItemInfo {
    public uint cbSize, fMask, fType, fState, wID; public IntPtr hSubMenu, hbmpChecked, hbmpUnchecked, dwItemData, dwTypeData;
    public uint cch; public IntPtr hbmpItem;
  }
  // Раскладка CMINVOKECOMMANDINFOEX из shobjidl: строки команды — указатели, число — MAKEINTRESOURCE.
  [StructLayout(LayoutKind.Sequential)] public struct InvokeInfo {
    public int cbSize, fMask; public IntPtr hwnd, lpVerb, lpParameters, lpDirectory; public int nShow, dwHotKey; public IntPtr hIcon, lpTitle,
      lpVerbW, lpParametersW, lpDirectoryW, lpTitleW; public int ptX, ptY;
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {
    [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int GetParent(out IShellItem ppsi);
    [PreserveSig] int GetDisplayName(uint sigdnName, out IntPtr ppszName);
    [PreserveSig] int GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    [PreserveSig] int Compare(IShellItem psi, uint hint, out int piOrder);
  }
  [ComImport, Guid("7E9FB0D3-919F-4307-AB2E-9B1860310C93"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem2 : IShellItem {
    // Для [ComImport] .NET не переносит методы базового интерфейса в таблицу вызовов:
    // без повторного объявления GetProperty и GetFileTime попадали на пять мест раньше
    // и обрушивали процесс (AccessViolation при чтении корзины на CI). Порядок — как в IShellItem.
    [PreserveSig] new int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    [PreserveSig] new int GetParent(out IShellItem ppsi);
    [PreserveSig] new int GetDisplayName(uint sigdnName, out IntPtr ppszName);
    [PreserveSig] new int GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    [PreserveSig] new int Compare(IShellItem psi, uint hint, out int piOrder);
    [PreserveSig] int GetPropertyStore(int flags, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int GetPropertyStoreWithCreateObject(int flags, IntPtr punkCreateObject, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int GetPropertyStoreForKeys(IntPtr rgKeys, uint cKeys, int flags, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int GetPropertyDescriptionList(ref PROPERTYKEY keyType, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int Update(IntPtr pbc);
    [PreserveSig] int GetProperty(ref PROPERTYKEY key, IntPtr ppropvar);
    [PreserveSig] int GetCLSID(ref PROPERTYKEY key, out Guid pclsid);
    [PreserveSig] int GetFileTime(ref PROPERTYKEY key, out System.Runtime.InteropServices.ComTypes.FILETIME pft);
    [PreserveSig] int GetInt32(ref PROPERTYKEY key, out int pi);
    [PreserveSig] int GetString(ref PROPERTYKEY key, out IntPtr ppsz);
    [PreserveSig] int GetUInt32(ref PROPERTYKEY key, out uint pui);
    [PreserveSig] int GetUInt64(ref PROPERTYKEY key, out ulong pull);
    [PreserveSig] int GetBool(ref PROPERTYKEY key, out int pf);
  }
  [ComImport, Guid("BCC18B79-BA16-442F-80C4-8A59C30C463B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItemImageFactory { [PreserveSig] int GetImage(SIZE size, uint flags, out IntPtr phbm); }
  [ComImport, Guid("70629033-E363-4A28-A567-0DB78006E6D7"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IEnumShellItems {
    [PreserveSig] int Next(uint celt, out IShellItem rgelt, out uint pceltFetched);
    [PreserveSig] int Skip(uint celt);
    [PreserveSig] int Reset();
    [PreserveSig] int Clone(out IEnumShellItems ppenum);
  }
  [ComImport, Guid("B63EA76D-1F85-456F-A19C-48159EFA858B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItemArray { [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppvOut); }
  [ComImport, Guid("000214E4-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IContextMenu {
    [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint flags);
    [PreserveSig] int InvokeCommand(IntPtr pici);
    [PreserveSig] int GetCommandString(UIntPtr idCmd, uint type, IntPtr reserved, IntPtr name, uint cchMax);
  }
  [ComImport, Guid("000214F4-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IContextMenu2 : IContextMenu {
    // Методы IContextMenu объявлены заново по той же причине, что в IShellItem2: иначе
    // HandleMenuMsg уходил в слот QueryContextMenu, меню наполнялось повторно с мусорными
    // аргументами, номера команд сдвигались («Удалить» отвечало open, «Свойства» — printto),
    // а подменю («Отправить», 7-Zip) падали с AccessViolation
    [PreserveSig] new int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint flags);
    [PreserveSig] new int InvokeCommand(IntPtr pici);
    [PreserveSig] new int GetCommandString(UIntPtr idCmd, uint type, IntPtr reserved, IntPtr name, uint cchMax);
    [PreserveSig] int HandleMenuMsg(uint msg, IntPtr wParam, IntPtr lParam);
  }
  [ComImport, Guid("973810AE-9599-4B88-9E4D-6EE98C9552DA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IEnumAssocHandlers { [PreserveSig] int Next(uint celt, out IAssocHandler rgelt, out uint pceltFetched); }
  [ComImport, Guid("F04061AC-1659-4A3F-A954-775AA57FC083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAssocHandler {
    [PreserveSig] int GetName([MarshalAs(UnmanagedType.LPWStr)] out string ppsz);
    [PreserveSig] int GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string ppsz);
    [PreserveSig] int GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] out string ppszPath, out int pIndex);
    [PreserveSig] int IsRecommended();
    [PreserveSig] int MakeDefault([MarshalAs(UnmanagedType.LPWStr)] string pszDescription);
    [PreserveSig] int Invoke([MarshalAs(UnmanagedType.Interface)] System.Runtime.InteropServices.ComTypes.IDataObject pdo);
    [PreserveSig] int CreateInvoker([MarshalAs(UnmanagedType.Interface)] System.Runtime.InteropServices.ComTypes.IDataObject pdo, out IntPtr ppInvoker);
  }

  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern int SHCreateItemFromParsingName(string path, IntPtr bindContext, ref Guid riid, out IShellItem item);
  [DllImport("shell32.dll")] static extern int SHCreateShellItemArrayFromIDLists(uint count, IntPtr[] pidls, out IShellItemArray array);
  [DllImport("shell32.dll")] static extern int SHGetIDListFromObject(IntPtr unknown, out IntPtr pidl);
  [DllImport("shell32.dll")] static extern int SHGetKnownFolderItem(ref Guid folder, uint flags, IntPtr token, ref Guid riid, out IShellItem item);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern int SHAssocEnumHandlers(string extension, int filter, out IEnumAssocHandlers handlers);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern int SHEmptyRecycleBin(IntPtr window, string root, uint flags);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern uint ExtractIconEx(string file, int index, IntPtr[] large, IntPtr[] small, uint icons);
  [DllImport("shlwapi.dll", CharSet=CharSet.Unicode)] static extern int SHLoadIndirectString(string source, StringBuilder buffer, uint size, IntPtr reserved);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetFileAttributes(string path);
  [DllImport("user32.dll")] static extern IntPtr CreatePopupMenu();
  [DllImport("user32.dll")] static extern bool DestroyMenu(IntPtr menu);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
  [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr menu);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMenuItemInfoW(IntPtr menu, uint item, bool byPosition, ref MenuItemInfo info);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr bitmap);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr dc, IntPtr bitmap, uint start, uint lines, byte[] pixels, ref BitmapInfo info, uint usage);

  static Guid IID_IShellItem = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
  static Guid IID_IEnumShellItems = new Guid("70629033-E363-4A28-A567-0DB78006E6D7");
  static Guid IID_IContextMenu = new Guid("000214E4-0000-0000-C000-000000000046");
  static Guid IID_IDataObject = new Guid("0000010E-0000-0000-C000-000000000046");
  static Guid BHID_EnumItems = new Guid("94F60519-2850-4924-AA5A-D15E84868039");
  static Guid BHID_SFUIObject = new Guid("3981E225-F559-11D3-8E3A-00C04F6837D5");
  static Guid BHID_DataObject = new Guid("B8C0BD9F-ED24-455C-83E6-D5390C4FE8C4");
  static Guid FOLDERID_RecycleBin = new Guid("B7534046-3ECB-4C18-BE4E-64CD4CB7D6AC");
  static PROPERTYKEY KEY_DeletedFrom = new PROPERTYKEY { fmtid = new Guid("9B174B33-40FF-11D2-A27E-00C04FC30871"), pid = 2 };
  static PROPERTYKEY KEY_DateDeleted = new PROPERTYKEY { fmtid = new Guid("9B174B33-40FF-11D2-A27E-00C04FC30871"), pid = 3 };
  static PROPERTYKEY KEY_Size = new PROPERTYKEY { fmtid = new Guid("B725F130-47EF-101A-A5F1-02608C9EEBAC"), pid = 12 };

  static void Check(int hr) { if (hr < 0) Marshal.ThrowExceptionForHR(hr); }
  static string Text(IShellItem item, uint kind) {
    IntPtr name = IntPtr.Zero;
    try { Check(item.GetDisplayName(kind, out name)); return Marshal.PtrToStringUni(name); }
    finally { if (name != IntPtr.Zero) Marshal.FreeCoTaskMem(name); }
  }
  static IShellItem Item(string path) {
    IShellItem item; Check(SHCreateItemFromParsingName(path, IntPtr.Zero, ref IID_IShellItem, out item)); return item;
  }
  static T Handler<T>(IShellItem item, Guid kind, Guid iid) where T : class {
    IntPtr raw; Check(item.BindToHandler(IntPtr.Zero, ref kind, ref iid, out raw));
    try { return (T)Marshal.GetObjectForIUnknown(raw); } finally { Marshal.Release(raw); }
  }
  static List<IShellItem> Children(IShellItem folder, int limit) {
    List<IShellItem> result = new List<IShellItem>();
    IEnumShellItems list = Handler<IEnumShellItems>(folder, BHID_EnumItems, IID_IEnumShellItems);
    for (;;) {
      IShellItem child; uint fetched;
      if (list.Next(1, out child, out fetched) != 0 || fetched == 0) break;
      result.Add(child); if (result.Count >= limit) break;
    }
    return result;
  }
  static string Error(string code, Exception failure) {
    Dictionary<string,object> answer = new Dictionary<string,object> { {"ok", false}, {"code", code}, {"stage", Stage} };
    if (failure != null) {
      answer["type"] = failure.GetType().Name; answer["hresult"] = failure.HResult.ToString("X8");
      // Текст нужен журналу диагностики и проверке на CI; пути диска из него вырезаются, человеку он не показывается.
      string detail = failure.Message ?? ""; detail = System.Text.RegularExpressions.Regex.Replace(detail, @"[A-Za-z]:\\[^\s'""]*|\\\\[^\s'""]+", "<путь>");
      answer["message"] = detail.Length > 300 ? detail.Substring(0, 300) : detail;
    }
    return Json(answer);
  }
  static string Json(object value) { JavaScriptSerializer json = new JavaScriptSerializer(); json.MaxJsonLength = 64 * 1024 * 1024; return json.Serialize(value); }
  static string Str(Dictionary<string,object> args, string key) { object value; return args.TryGetValue(key, out value) ? value as string : null; }
  static bool Flag(Dictionary<string,object> args, string key) { object value; return args.TryGetValue(key, out value) && value is bool && (bool)value; }
  /** Массив строк из запроса. JavaScriptSerializer отдаёт массив то как ArrayList, то как object[]: принимается любой перечислимый. */
  static List<string> Strings(Dictionary<string,object> args, string key) {
    object raw; List<string> result = new List<string>();
    if (!args.TryGetValue(key, out raw) || raw == null || raw is string || !(raw is System.Collections.IEnumerable)) throw new InvalidOperationException("ARGUMENT_" + key);
    foreach (object item in (System.Collections.IEnumerable)raw) { if (!(item is string)) throw new InvalidOperationException("ARGUMENT_" + key); result.Add((string)item); }
    return result;
  }
  static int Number(Dictionary<string,object> args, string key, int fallback) { object value; return args.TryGetValue(key, out value) && value is int ? (int)value : fallback; }

  // ------------------------------------------------------------ картинки
  /** HBITMAP -> PNG с сохранением прозрачности: FromHbitmap рисует чёрный квадрат вокруг значка. */
  static Dictionary<string,object> BitmapPng(IntPtr bitmap) {
    IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
    try {
      BitmapInfo info = new BitmapInfo(); info.header.size = 40;
      if (GetDIBits(dc, bitmap, 0, 0, null, ref info, 0) == 0) throw new InvalidOperationException("IMAGE_HEADER");
      int width = info.header.width, height = Math.Abs(info.header.height);
      if (width < 1 || height < 1 || width > 2048 || height > 2048) throw new InvalidDataException("IMAGE_DIMENSIONS");
      info.header.height = -height; info.header.planes = 1; info.header.bits = 32; info.header.compression = 0;
      byte[] pixels = new byte[checked(width * height * 4)];
      if (GetDIBits(dc, bitmap, 0, (uint)height, pixels, ref info, 0) != height) throw new InvalidOperationException("IMAGE_PIXELS");
      bool alpha = false; for (int i = 3; i < pixels.Length; i += 4) if (pixels[i] != 0) { alpha = true; break; }
      if (!alpha) for (int i = 3; i < pixels.Length; i += 4) pixels[i] = 255;
      using (Bitmap picture = new Bitmap(width, height, PixelFormat.Format32bppPArgb))
      using (MemoryStream bytes = new MemoryStream()) {
        BitmapData data = picture.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
        try { Marshal.Copy(pixels, 0, data.Scan0, pixels.Length); } finally { picture.UnlockBits(data); }
        picture.Save(bytes, ImageFormat.Png);
        return new Dictionary<string,object> { {"base64", Convert.ToBase64String(bytes.ToArray())}, {"width", width}, {"height", height} };
      }
    } finally { DeleteDC(dc); }
  }
  /** thumbOnly: только содержимое файла. Облачные заглушки (файл ещё не скачан) получают значок: миниатюра заставила бы Windows скачать файл. */
  static string Thumbnail(Dictionary<string,object> args) {
    string path = Str(args, "path"); int size = Math.Max(16, Math.Min(512, Number(args, "size", 96)));
    Stage = "thumbnail";
    uint attributes = GetFileAttributes(path);
    bool placeholder = attributes != 0xFFFFFFFF && (attributes & (0x400000u | 0x40000u | 0x1000u)) != 0;
    IShellItem item = Item(path); IntPtr bitmap = IntPtr.Zero;
    try {
      IShellItemImageFactory factory = (IShellItemImageFactory)item;
      SIZE wanted = new SIZE { cx = size, cy = size };
      // Сначала только содержимое файла (THUMBNAILONLY): тогда точно известно, миниатюра это или значок типа.
      bool real = false;
      if (!placeholder) { real = factory.GetImage(wanted, 0x8u, out bitmap) >= 0 && bitmap != IntPtr.Zero; if (!real && bitmap != IntPtr.Zero) { DeleteObject(bitmap); bitmap = IntPtr.Zero; } }
      if (!real && !Flag(args, "thumbOnly")) {
        // ICONONLY не читает содержимое: облачная заглушка не будет скачана, а у типа без миниатюры будет его значок.
        if (factory.GetImage(wanted, 0x4u, out bitmap) < 0) bitmap = IntPtr.Zero;
      }
      if (bitmap == IntPtr.Zero) return Json(new Dictionary<string,object> { {"ok", true}, {"data", null} });
      Dictionary<string,object> png = BitmapPng(bitmap);
      png["thumbnail"] = real;
      return Json(new Dictionary<string,object> { {"ok", true}, {"data", png} });
    } finally { if (bitmap != IntPtr.Zero) DeleteObject(bitmap); Marshal.ReleaseComObject(item); }
  }
  static string IconPng(string location, int index) {
    IntPtr[] small = new IntPtr[1];
    try {
      if (ExtractIconEx(Environment.ExpandEnvironmentVariables(location), index, null, small, 1) == 0 || small[0] == IntPtr.Zero) return null;
      using (Icon icon = Icon.FromHandle(small[0]))
      using (Bitmap picture = icon.ToBitmap())
      using (MemoryStream bytes = new MemoryStream()) { picture.Save(bytes, ImageFormat.Png); return Convert.ToBase64String(bytes.ToArray()); }
    } catch { return null; }
    finally { if (small[0] != IntPtr.Zero) DestroyIcon(small[0]); }
  }

  // ------------------------------------------------------ контекстное меню
  sealed class MenuSession {
    public IContextMenu Menu; public IntPtr Handle; public Dictionary<int,string> Labels = new Dictionary<int,string>();
    public string Token = Guid.NewGuid().ToString("N");
    public void Dispose() { if (Handle != IntPtr.Zero) { DestroyMenu(Handle); Handle = IntPtr.Zero; } if (Menu != null) { Marshal.ReleaseComObject(Menu); Menu = null; } }
  }
  static MenuSession Session;
  static void CloseSession() { if (Session != null) { Session.Dispose(); Session = null; } }

  static IContextMenu MenuFor(IShellItem[] items) {
    if (items.Length == 1) return Handler<IContextMenu>(items[0], BHID_SFUIObject, IID_IContextMenu);
    // Несколько объектов: общий IContextMenu строится по массиву абсолютных PIDL.
    IntPtr[] pidls = new IntPtr[items.Length];
    try {
      for (int i = 0; i < items.Length; i++) {
        IntPtr unknown = Marshal.GetIUnknownForObject(items[i]);
        try { Check(SHGetIDListFromObject(unknown, out pidls[i])); } finally { Marshal.Release(unknown); }
      }
      IShellItemArray array; Check(SHCreateShellItemArrayFromIDLists((uint)pidls.Length, pidls, out array));
      IntPtr raw; Guid kind = BHID_SFUIObject, iid = IID_IContextMenu;
      Check(array.BindToHandler(IntPtr.Zero, ref kind, ref iid, out raw));
      try { return (IContextMenu)Marshal.GetObjectForIUnknown(raw); } finally { Marshal.Release(raw); }
    } finally { foreach (IntPtr pidl in pidls) if (pidl != IntPtr.Zero) Marshal.FreeCoTaskMem(pidl); }
  }
  [System.Runtime.ExceptionServices.HandleProcessCorruptedStateExceptions, System.Security.SecurityCritical]
  static string Verb(IContextMenu menu, int offset) {
    IntPtr buffer = Marshal.AllocCoTaskMem(512 * 2);
    try {
      Marshal.WriteInt16(buffer, 0);
      // GCS_VERBW: каноничное имя команды, не зависящее от языка Windows.
      if (menu.GetCommandString((UIntPtr)(uint)offset, 4u, IntPtr.Zero, buffer, 512) < 0) return null;
      string verb = Marshal.PtrToStringUni(buffer); return String.IsNullOrEmpty(verb) ? null : verb;
    } catch { return null; } finally { Marshal.FreeCoTaskMem(buffer); }
  }
  /** Что ответил GetCommandString на запрос (W — GCS_VERBW, A — GCS_VERBA): для журнала диагностики, не для интерфейса. */
  [System.Runtime.ExceptionServices.HandleProcessCorruptedStateExceptions, System.Security.SecurityCritical]
  static string VerbProbe(IContextMenu menu, int offset) {
    IntPtr buffer = Marshal.AllocCoTaskMem(512 * 2); string report = "";
    try {
      foreach (uint kind in new uint[] { 4u, 0u }) {
        Marshal.WriteInt16(buffer, 0); string value = "";
        int hr = -1; try { hr = menu.GetCommandString((UIntPtr)(uint)offset, kind, IntPtr.Zero, buffer, 512); value = kind == 4u ? Marshal.PtrToStringUni(buffer) : Marshal.PtrToStringAnsi(buffer); } catch (Exception failure) { value = failure.GetType().Name; }
        report += (kind == 4u ? "W" : "A") + ":" + hr.ToString("X8") + ":" + value + " ";
      }
      return report;
    } finally { Marshal.FreeCoTaskMem(buffer); }
  }
  static bool TraceOn { get { return Environment.GetEnvironmentVariable("FLUX_SHELL_TRACE") == "1"; } }
  /** Шаги пишутся в stderr только при FLUX_SHELL_TRACE=1 (проверка на CI): при аварийном завершении по ним видно, где оно случилось. */
  static void Trace(string text) { if (TraceOn) { Console.Error.WriteLine("FLUX_TRACE:" + text); Console.Error.Flush(); } }
  static string CleanLabel(string raw) {
    if (raw == null) return "";
    int tab = raw.IndexOf('\t'); if (tab >= 0) raw = raw.Substring(0, tab);
    return raw.Replace("&&", "\u0001").Replace("&", "").Replace("\u0001", "&").Trim();
  }
  static List<object> ReadMenu(IntPtr handle, IContextMenu menu, uint first, MenuSession session, int depth) {
    List<object> result = new List<object>();
    IContextMenu2 second = menu as IContextMenu2;
    int count = GetMenuItemCount(handle);
    for (int index = 0; index < count && index < 200; index++) {
      MenuItemInfo info = new MenuItemInfo(); info.cbSize = (uint)Marshal.SizeOf(typeof(MenuItemInfo));
      info.fMask = 0x1u | 0x2u | 0x4u | 0x100u; // STATE | ID | SUBMENU | FTYPE
      if (!GetMenuItemInfoW(handle, (uint)index, true, ref info)) continue;
      if ((info.fType & 0x800u) != 0) { result.Add(new Dictionary<string,object> { {"id", -1}, {"label", ""}, {"enabled", false}, {"separator", true} }); continue; }
      if (info.hSubMenu != IntPtr.Zero && second != null && depth < 3) {
        // «Отправить» и «Открыть с помощью» наполняются, только когда Windows сообщит о раскрытии подменю.
        try { second.HandleMenuMsg(0x117u, info.hSubMenu, (IntPtr)index); } catch { }
      }
      // Строка читается вторым вызовом: размер буфера известен только после первого.
      string label = "";
      MenuItemInfo text = new MenuItemInfo(); text.cbSize = (uint)Marshal.SizeOf(typeof(MenuItemInfo)); text.fMask = 0x40u; text.fType = 0;
      if (GetMenuItemInfoW(handle, (uint)index, true, ref text) && text.cch > 0 && text.cch < 1024) {
        IntPtr buffer = Marshal.AllocCoTaskMem((int)(text.cch + 1) * 2);
        try { text.dwTypeData = buffer; text.cch++; if (GetMenuItemInfoW(handle, (uint)index, true, ref text)) label = CleanLabel(Marshal.PtrToStringUni(buffer)); }
        finally { Marshal.FreeCoTaskMem(buffer); }
      }
      bool hasSub = info.hSubMenu != IntPtr.Zero;
      if (label.Length == 0 && !hasSub) continue; // пункты с собственной отрисовкой без текста показать нечем
      int offset = hasSub ? -1 : (int)info.wID - (int)first;
      Dictionary<string,object> entry = new Dictionary<string,object> { {"id", offset}, {"label", label}, {"enabled", (info.fState & 0x3u) == 0}, {"checked", (info.fState & 0x8u) != 0} };
      if (TraceOn) Trace("menu: probe " + offset);
      if (TraceOn) entry["probe"] = "wID=" + info.wID + " offset=" + offset + " sub=" + hasSub + " " + VerbProbe(menu, offset);
      if (!hasSub) { string verb = Verb(menu, offset); if (verb != null) entry["verb"] = verb; session.Labels[offset] = label; }
      else if (depth < 3) { List<object> inner = ReadMenu(info.hSubMenu, menu, first, session, depth + 1); entry["submenu"] = inner; }
      result.Add(entry);
    }
    return result;
  }
  static string MenuOpen(Dictionary<string,object> args) {
    Stage = "menu-open";
    List<string> list = Strings(args, "paths");
    if (list.Count < 1 || list.Count > 100) throw new InvalidOperationException("MENU_COUNT");
    CloseSession();
    IShellItem[] items = new IShellItem[list.Count];
    for (int i = 0; i < items.Length; i++) items[i] = Item(list[i]);
    MenuSession session = new MenuSession();
    try {
      session.Menu = MenuFor(items); session.Handle = CreatePopupMenu();
      // EXPLORE | CANRENAME — как просит сам Проводник; EXTENDEDVERBS — «классическое» меню с Shift.
      uint flags = 0x4u | 0x10u | (Flag(args, "extended") ? 0x100u : 0u);
      int hr = session.Menu.QueryContextMenu(session.Handle, 0, 1, 0x7FFF, flags);
      if (hr < 0) Marshal.ThrowExceptionForHR(hr);
      List<object> tree = ReadMenu(session.Handle, session.Menu, 1, session, 0);
      Session = session;
      Dictionary<string,object> data = new Dictionary<string,object> { {"token", session.Token}, {"items", tree} };
      if (TraceOn) { string scan = "top=" + (hr & 0xFFFF) + " "; for (int offset = 0; offset < (hr & 0xFFFF) && offset < 400; offset++) { Trace("menu: scan " + offset); scan += offset + "=" + (Verb(session.Menu, offset) ?? "-") + " "; } data["scan"] = scan; }
      return Json(new Dictionary<string,object> { {"ok", true}, {"data", data} });
    } catch { session.Dispose(); throw; }
  }
  static string MenuInvoke(Dictionary<string,object> args) {
    Stage = "menu-invoke";
    string token = Str(args, "token"); int id = Number(args, "id", -1); string label = Str(args, "label");
    if (Session == null || Session.Token != token) return Error("MENU_EXPIRED", null);
    string known;
    // Номер без совпавшей подписи — другое меню: вызывать «по номеру» вслепую нельзя.
    if (!Session.Labels.TryGetValue(id, out known) || known != label) return Error("MENU_CHANGED", null);
    return InvokeOffset(Session.Menu, id, false);
  }
  static string InvokeOffset(IContextMenu menu, int offset, bool noUi) {
    InvokeInfo info = new InvokeInfo(); info.cbSize = Marshal.SizeOf(typeof(InvokeInfo));
    info.fMask = 0x4000 | (noUi ? 0x400 : 0); info.lpVerb = (IntPtr)offset; info.lpVerbW = (IntPtr)offset; info.nShow = 1;
    IntPtr memory = Marshal.AllocHGlobal(info.cbSize);
    try { Marshal.StructureToPtr(info, memory, false); Check(menu.InvokeCommand(memory)); }
    finally { Marshal.FreeHGlobal(memory); }
    return Json(new Dictionary<string,object> { {"ok", true}, {"data", new Dictionary<string,object> { {"invoked", true} }} });
  }
  /** Вызов команды по каноничному имени без показа меню (pintohome, undelete…). Возвращает false, если у объекта такой команды нет. */
  static bool InvokeVerb(IShellItem item, string verb, bool noUi) {
    IContextMenu menu = Handler<IContextMenu>(item, BHID_SFUIObject, IID_IContextMenu); IntPtr handle = CreatePopupMenu();
    try {
      int hr = menu.QueryContextMenu(handle, 0, 1, 0x7FFF, 0x4u); if (hr < 0) Marshal.ThrowExceptionForHR(hr);
      int top = (hr & 0xFFFF);
      for (int offset = 0; offset < top; offset++) if (Verb(menu, offset) == verb) { InvokeOffset(menu, offset, noUi); return true; }
      return false;
    } finally { DestroyMenu(handle); Marshal.ReleaseComObject(menu); }
  }
  static List<string> VerbsOf(IShellItem item) {
    List<string> verbs = new List<string>();
    IContextMenu menu = Handler<IContextMenu>(item, BHID_SFUIObject, IID_IContextMenu); IntPtr handle = CreatePopupMenu();
    try {
      int hr = menu.QueryContextMenu(handle, 0, 1, 0x7FFF, 0x4u); if (hr < 0) return verbs;
      int top = (hr & 0xFFFF);
      for (int offset = 0; offset < top; offset++) { string verb = Verb(menu, offset); if (verb != null) verbs.Add(verb); }
      return verbs;
    } finally { DestroyMenu(handle); Marshal.ReleaseComObject(menu); }
  }

  // ------------------------------------------------------ Быстрый доступ
  static string QuickAccess() {
    Stage = "quick-access";
    IShellItem home = Item("shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}");
    List<object> result = new List<object>();
    foreach (IShellItem child in Children(home, 200)) {
      try {
        string path = null; try { path = Text(child, 0x80058000u); } catch { }
        if (String.IsNullOrEmpty(path) || !Directory.Exists(path)) continue; // виртуальные и недоступные не открыть мостом
        // Закреплена ли папка, говорит сама Windows: у закреплённой есть команда открепления.
        List<string> verbs = VerbsOf(child);
        result.Add(new Dictionary<string,object> { {"name", Text(child, 0u)}, {"path", path}, {"pinned", verbs.Contains("unpinfromhome")} });
      } finally { Marshal.ReleaseComObject(child); }
    }
    return Json(new Dictionary<string,object> { {"ok", true}, {"data", result} });
  }
  const string QuickHome = "shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}";
  static string SamePath(string value) { return (value ?? "").TrimEnd('\\').ToLowerInvariant(); }
  /** Элемент Быстрого доступа с этим путём (или null). Вызывающий отпускает COM-объект. */
  static IShellItem QuickChild(string path) {
    string wanted = SamePath(path); IShellItem found = null;
    foreach (IShellItem child in Children(Item(QuickHome), 500)) {
      string own = null; try { own = Text(child, 0x80058000u); } catch { }
      if (found == null && own != null && SamePath(own) == wanted) found = child; else Marshal.ReleaseComObject(child);
    }
    return found;
  }
  static bool QuickPinned(string path) {
    IShellItem child = QuickChild(path);
    if (child == null) return false;
    try { return VerbsOf(child).Contains("unpinfromhome"); } finally { Marshal.ReleaseComObject(child); }
  }
  static string QuickPin(Dictionary<string,object> args) {
    Stage = "quick-pin";
    string path = Str(args, "path"); bool pin = Flag(args, "pin");
    bool done = false;
    if (pin) {
      IShellItem folder = Item(path);
      try { done = InvokeVerb(folder, "pintohome", true); } finally { Marshal.ReleaseComObject(folder); }
    } else {
      // Открепляется тот элемент, который Проводник показывает в самом Быстром доступе: у обычной папки глагола открепления может не быть.
      Stage = "quick-unpin";
      IShellItem child = QuickChild(path);
      if (child != null) { try { done = InvokeVerb(child, "unpinfromhome", true); } finally { Marshal.ReleaseComObject(child); } }
      if (!done) { IShellItem folder = Item(path); try { done = InvokeVerb(folder, "unpinfromhome", true); } finally { Marshal.ReleaseComObject(folder); } }
    }
    // Список закреплённого Windows обновляет не мгновенно: ждётся, пока состояние сменится (до 4 секунд).
    Stage = "quick-wait";
    bool state = QuickPinned(path);
    for (int attempt = 0; attempt < 26 && state != pin; attempt++) { System.Threading.Thread.Sleep(150); state = QuickPinned(path); }
    // Нет команды — уже в нужном состоянии: повторное закрепление не ошибка.
    return Json(new Dictionary<string,object> { {"ok", true}, {"data", new Dictionary<string,object> { {"changed", done}, {"pinned", state} }} });
  }

  // ---------------------------------------------------- облачные корни
  static string CloudRoots() {
    Stage = "cloud-roots";
    List<object> result = new List<object>();
    string sid = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
    using (RegistryKey root = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\SyncRootManager")) {
      if (root == null) return Json(new Dictionary<string,object> { {"ok", true}, {"data", result} });
      foreach (string name in root.GetSubKeyNames()) {
        try {
          using (RegistryKey key = root.OpenSubKey(name)) {
            if (key == null) continue;
            string folder = null;
            using (RegistryKey users = key.OpenSubKey("UserSyncRoots")) {
              if (users != null) { folder = users.GetValue(sid) as string; if (folder == null) foreach (string other in users.GetValueNames()) { folder = users.GetValue(other) as string; if (folder != null) break; } }
            }
            if (String.IsNullOrEmpty(folder) || !Directory.Exists(folder)) continue;
            string title = key.GetValue("DisplayNameResource") as string;
            if (title != null && title.StartsWith("@")) { StringBuilder buffer = new StringBuilder(260); title = SHLoadIndirectString(title, buffer, 260, IntPtr.Zero) == 0 ? buffer.ToString() : null; }
            string folderName = Path.GetFileName(folder.TrimEnd('\\'));
            // У OneDrive для работы папка называется «OneDrive - Компания», а ресурс — просто «OneDrive»: Проводник показывает папку.
            if (String.IsNullOrWhiteSpace(title) || (name.StartsWith("OneDrive", StringComparison.OrdinalIgnoreCase) && folderName.StartsWith("OneDrive", StringComparison.OrdinalIgnoreCase))) title = folderName;
            string provider = name.StartsWith("OneDrive", StringComparison.OrdinalIgnoreCase) ? "onedrive" : name.IndexOf("Yandex", StringComparison.OrdinalIgnoreCase) >= 0 ? "yandex" : "other";
            string icon = null;
            try {
              IShellItem folderItem = Item(folder); IntPtr bitmap = IntPtr.Zero;
              try { if (((IShellItemImageFactory)folderItem).GetImage(new SIZE { cx = 32, cy = 32 }, 0x4u, out bitmap) >= 0 && bitmap != IntPtr.Zero) icon = (string)BitmapPng(bitmap)["base64"]; }
              finally { if (bitmap != IntPtr.Zero) DeleteObject(bitmap); Marshal.ReleaseComObject(folderItem); }
            } catch { }
            result.Add(new Dictionary<string,object> { {"id", name}, {"name", title}, {"provider", provider}, {"path", folder}, {"icon", icon} });
          }
        } catch { }
      }
    }
    return Json(new Dictionary<string,object> { {"ok", true}, {"data", result} });
  }

  // ------------------------------------------------- «Открыть с помощью»
  static string OpenWithList(Dictionary<string,object> args) {
    Stage = "open-with-list";
    string extension = Path.GetExtension(Str(args, "path"));
    List<object> result = new List<object>();
    if (String.IsNullOrEmpty(extension)) return Json(new Dictionary<string,object> { {"ok", true}, {"data", result} });
    IEnumAssocHandlers handlers; Check(SHAssocEnumHandlers(extension, 0, out handlers));
    for (int guard = 0; guard < 64; guard++) {
      IAssocHandler handler; uint fetched;
      if (handlers.Next(1, out handler, out fetched) != 0 || fetched == 0) break;
      try {
        string name, title, iconPath = null; int iconIndex = 0;
        if (handler.GetName(out name) < 0 || handler.GetUIName(out title) < 0) continue;
        handler.GetIconLocation(out iconPath, out iconIndex);
        result.Add(new Dictionary<string,object> { {"name", name}, {"title", title}, {"recommended", handler.IsRecommended() == 0}, {"icon", String.IsNullOrEmpty(iconPath) ? null : IconPng(iconPath, iconIndex)} });
      } finally { Marshal.ReleaseComObject(handler); }
    }
    return Json(new Dictionary<string,object> { {"ok", true}, {"data", result} });
  }
  static string OpenWith(Dictionary<string,object> args) {
    Stage = "open-with";
    string path = Str(args, "path"), wanted = Str(args, "name");
    string extension = Path.GetExtension(path);
    IShellItem item = Item(path);
    System.Runtime.InteropServices.ComTypes.IDataObject data = Handler<System.Runtime.InteropServices.ComTypes.IDataObject>(item, BHID_DataObject, IID_IDataObject);
    IEnumAssocHandlers handlers; Check(SHAssocEnumHandlers(extension, 0, out handlers));
    for (int guard = 0; guard < 64; guard++) {
      IAssocHandler handler; uint fetched;
      if (handlers.Next(1, out handler, out fetched) != 0 || fetched == 0) break;
      try {
        string name; if (handler.GetName(out name) < 0 || name != wanted) continue;
        Check(handler.Invoke(data));
        return Json(new Dictionary<string,object> { {"ok", true}, {"data", new Dictionary<string,object> { {"opened", true} }} });
      } finally { Marshal.ReleaseComObject(handler); }
    }
    return Error("HANDLER_NOT_FOUND", null);
  }

  // ------------------------------------------------------------ корзина
  [DllImport("ole32.dll")] static extern int PropVariantClear(IntPtr value);
  /** Значение свойства как PROPVARIANT: IShellItem2.GetFileTime на элементах корзины обрушивал процесс (AccessViolation в журнале CI), поэтому все свойства читаются одним общим GetProperty. Возвращает vt и 64-битное значение или указатель. */
  static bool BinProperty(IShellItem2 item, PROPERTYKEY key, out ushort vt, out long value, out string text) {
    vt = 0; value = 0; text = null;
    IntPtr variant = Marshal.AllocCoTaskMem(32);
    try {
      for (int index = 0; index < 32; index++) Marshal.WriteByte(variant, index, 0);
      if (item.GetProperty(ref key, variant) < 0) return false;
      vt = (ushort)Marshal.ReadInt16(variant);
      if (vt == 31 || vt == 8) text = Marshal.PtrToStringUni(Marshal.ReadIntPtr(variant, 8)); // VT_LPWSTR, VT_BSTR
      else value = Marshal.ReadInt64(variant, 8); // VT_FILETIME, VT_UI8, VT_I8
      return true;
    } finally { PropVariantClear(variant); Marshal.FreeCoTaskMem(variant); }
  }
  static DateTime? Deleted(IShellItem2 item) {
    ushort vt; long ticks; string unused;
    if (!BinProperty(item, KEY_DateDeleted, out vt, out ticks, out unused) || vt != 64 || ticks <= 0) return null;
    return DateTime.FromFileTimeUtc(ticks);
  }
  static string BinString(IShellItem2 item, PROPERTYKEY key) {
    ushort vt; long unused; string text;
    return BinProperty(item, key, out vt, out unused, out text) ? text : null;
  }
  static IShellItem Bin() {
    Stage = "bin-known-folder"; Trace("bin: SHGetKnownFolderItem");
    IShellItem bin = null; int hr = SHGetKnownFolderItem(ref FOLDERID_RecycleBin, 0, IntPtr.Zero, ref IID_IShellItem, out bin);
    if (hr >= 0 && bin != null) return bin;
    // Запасной путь: та же корзина по имени для разбора, как её называет Проводник.
    Stage = "bin-parse";
    return Item("shell:::{645FF040-5081-101B-9F08-00AA002F954E}");
  }
  static string BinList() {
    Stage = "bin-list";
    List<object> result = new List<object>();
    Trace("bin: open folder");
    IShellItem bin = Bin(); Stage = "bin-enum"; Trace("bin: enumerate");
    int number = 0;
    foreach (IShellItem child in Children(bin, 20000)) {
      try {
        number++; Trace("bin: item " + number + " name");
        string name = Text(child, 0u); Trace("bin: item " + number + " key");
        string key = Text(child, 0x80028000u); Trace("bin: item " + number + " cast");
        IShellItem2 item = (IShellItem2)child;
        uint attributes; child.GetAttributes(0x20000000u, out attributes); Trace("bin: item " + number + " size");
        ushort sizeType; long size; string unusedText;
        bool hasSize = BinProperty(item, KEY_Size, out sizeType, out size, out unusedText) && (sizeType == 21 || sizeType == 20) && size >= 0; Trace("bin: item " + number + " date");
        DateTime? when = Deleted(item); Trace("bin: item " + number + " from");
        string from = BinString(item, KEY_DeletedFrom); Trace("bin: item " + number + " done");
        result.Add(new Dictionary<string,object> {
          {"key", key}, {"name", name}, {"location", from},
          {"deletedAt", when.HasValue ? when.Value.ToString("o") : null}, {"size", hasSize ? (object)size : null}, {"directory", (attributes & 0x20000000u) != 0}
        });
      } catch (Exception failure) { Trace("bin: item " + number + " failed " + failure.GetType().Name + " " + failure.Message); } finally { Marshal.ReleaseComObject(child); }
    }
    Trace("bin: items " + result.Count);
    return Json(new Dictionary<string,object> { {"ok", true}, {"data", result} });
  }
  /** Команды корзины идут по разбираемым именам из последнего списка; NO_UI — без окон подтверждения. Действие над найденными. */
  static string BinAct(Dictionary<string,object> args, string verb) {
    Stage = "bin-" + verb;
    HashSet<string> wanted = new HashSet<string>(Strings(args, "keys"), StringComparer.OrdinalIgnoreCase);
    int done = 0, failed = 0;
    foreach (IShellItem child in Children(Bin(), 20000)) {
      try {
        if (!wanted.Contains(Text(child, 0x80028000u))) continue;
        try { if (InvokeVerb(child, verb, true)) done++; else failed++; } catch { failed++; }
      } finally { Marshal.ReleaseComObject(child); }
    }
    return Json(new Dictionary<string,object> { {"ok", true}, {"data", new Dictionary<string,object> { {"done", done}, {"failed", failed} }} });
  }
  /**
   * «Удалить навсегда» — не командой оболочки: delete у элемента корзины показывает окно
   * подтверждения и при NO_UI (на CI оно висело до таймаута, у человека всплыло бы второе
   * подтверждение после своего во Flux). Элемент корзины на диске — пара файлов в $Recycle.Bin:
   * $R… (содержимое) и $I… (имя, место, дата). Так удаляет и сама Windows. Удаляется только
   * то, что лежит внутри $Recycle.Bin и называется $R…, — иначе отказ по объекту.
   */
  static string BinPurge(Dictionary<string,object> args) {
    Stage = "bin-purge";
    HashSet<string> wanted = new HashSet<string>(Strings(args, "keys"), StringComparer.OrdinalIgnoreCase);
    int done = 0, failed = 0;
    foreach (IShellItem child in Children(Bin(), 20000)) {
      try {
        string key = Text(child, 0x80028000u);
        if (!wanted.Contains(key)) continue;
        try {
          string full = Path.GetFullPath(key), name = Path.GetFileName(full), folder = Path.GetDirectoryName(full);
          bool inBin = folder != null && full.IndexOf("\\$Recycle.Bin\\", StringComparison.OrdinalIgnoreCase) >= 0;
          if (!inBin || !name.StartsWith("$R", StringComparison.OrdinalIgnoreCase)) { failed++; continue; }
          string info = Path.Combine(folder, "$I" + name.Substring(2));
          if (Directory.Exists(full)) Directory.Delete(full, true); else if (File.Exists(full)) File.Delete(full); else { failed++; continue; }
          if (File.Exists(info)) File.Delete(info);
          done++;
        } catch { failed++; }
      } finally { Marshal.ReleaseComObject(child); }
    }
    return Json(new Dictionary<string,object> { {"ok", true}, {"data", new Dictionary<string,object> { {"done", done}, {"failed", failed} }} });
  }
  /** Возврат по исходному пути — для отмены удаления: корзина не выдаёт идентификатор при удалении, поэтому ищется по месту и времени. */
  static string BinRestoreOriginal(Dictionary<string,object> args) {
    Stage = "bin-restore-original";
    string original = Str(args, "path"); string folder = Path.GetDirectoryName(original), file = Path.GetFileName(original);
    DateTime after = DateTime.FromFileTimeUtc(0); object stamp;
    if (args.TryGetValue("deletedAfter", out stamp) && (stamp is long || stamp is int || stamp is double)) after = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(Convert.ToDouble(stamp));
    IShellItem best = null; DateTime bestTime = DateTime.MinValue;
    foreach (IShellItem child in Children(Bin(), 20000)) {
      bool keep = false;
      try {
        IShellItem2 item = (IShellItem2)child;
        string from = BinString(item, KEY_DeletedFrom); string name = Text(child, 0u);
        DateTime? when = Deleted(item);
        // Имя в корзине может быть показано без расширения (настройка Проводника): сравнивается и так, и так.
        bool sameName = String.Equals(name, file, StringComparison.OrdinalIgnoreCase) || String.Equals(name, Path.GetFileNameWithoutExtension(file), StringComparison.OrdinalIgnoreCase);
        bool sameFolder = from != null && String.Equals(from.TrimEnd('\\'), folder.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
        if (sameName && sameFolder && when.HasValue && when.Value >= after && when.Value >= bestTime) { if (best != null) Marshal.ReleaseComObject(best); best = child; bestTime = when.Value; keep = true; }
      } catch { } finally { if (!keep) Marshal.ReleaseComObject(child); }
    }
    if (best == null) return Error("BIN_ITEM_NOT_FOUND", null);
    try { InvokeVerb(best, "undelete", true); } finally { Marshal.ReleaseComObject(best); }
    return Json(new Dictionary<string,object> { {"ok", true}, {"data", new Dictionary<string,object> { {"restored", true} }} });
  }
  static string BinEmpty() {
    Stage = "bin-empty";
    int hr = SHEmptyRecycleBin(IntPtr.Zero, null, 0x1u | 0x2u | 0x4u);
    // S_FALSE у пустой корзины: очищать нечего — не ошибка.
    if (hr < 0 && hr != unchecked((int)0x8000FFFF)) Marshal.ThrowExceptionForHR(hr);
    return Json(new Dictionary<string,object> { {"ok", true}, {"data", new Dictionary<string,object> { {"emptied", true} }} });
  }

  // ------------------------------------------------------------ вход
  /** Одна строка JSON -> одна строка JSON. Пути не попадают в сообщения об ошибках. */
  [System.Runtime.ExceptionServices.HandleProcessCorruptedStateExceptions, System.Security.SecurityCritical]
  public static string Handle(string line) {
    object id = null;
    try {
      if (System.Threading.Thread.CurrentThread.GetApartmentState() != System.Threading.ApartmentState.STA) return Wrap(null, Error("STA_REQUIRED", null));
      JavaScriptSerializer parser = new JavaScriptSerializer(); parser.MaxJsonLength = 4 * 1024 * 1024;
      Dictionary<string,object> request = parser.DeserializeObject(line) as Dictionary<string,object>;
      if (request == null) return Wrap(null, Error("BAD_REQUEST", null));
      request.TryGetValue("id", out id);
      string command = Str(request, "cmd"); object raw; request.TryGetValue("args", out raw);
      Dictionary<string,object> args = raw as Dictionary<string,object> ?? new Dictionary<string,object>();
      string answer;
      switch (command) {
        case "ping": answer = Json(new Dictionary<string,object> { {"ok", true}, {"data", "pong"} }); break;
        case "thumbnail": answer = Thumbnail(args); break;
        case "quick-access": answer = QuickAccess(); break;
        case "quick-pin": answer = QuickPin(args); break;
        case "cloud-roots": answer = CloudRoots(); break;
        case "open-with-list": answer = OpenWithList(args); break;
        case "open-with": answer = OpenWith(args); break;
        case "menu-open": answer = MenuOpen(args); break;
        case "menu-invoke": answer = MenuInvoke(args); break;
        case "menu-close": CloseSession(); answer = Json(new Dictionary<string,object> { {"ok", true}, {"data", true} }); break;
        case "bin-list": answer = BinList(); break;
        case "bin-restore": answer = BinAct(args, "undelete"); break;
        case "bin-purge": answer = BinPurge(args); break;
        case "bin-restore-original": answer = BinRestoreOriginal(args); break;
        case "bin-empty": answer = BinEmpty(); break;
        default: answer = Error("UNKNOWN_COMMAND", null); break;
      }
      return Wrap(id, answer);
    } catch (Exception failure) {
      while (failure.InnerException != null) failure = failure.InnerException;
      return Wrap(id, Error("HELPER_FAILED", failure));
    }
  }
  /** Номер запроса вставляется в готовый объект ответа, чтобы не сериализовать картинки второй раз; без номера ответ не сопоставить. */
  static string Wrap(object id, string answer) { return "{\"id\":" + new JavaScriptSerializer().Serialize(id) + "," + answer.Substring(1); }
}
`;

/** Цикл обслуживания: готовность — одна строка {"ready":true}, дальше — запрос и ответ построчно. */
export const NATIVE_SHELL_SCRIPT = `$ErrorActionPreference = 'Stop'
try {
Add-Type -ReferencedAssemblies System.Drawing,System.Web.Extensions -TypeDefinition @'
${NATIVE_SHELL_SOURCE}
'@
$utf8 = New-Object System.Text.UTF8Encoding($false)
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$writer.AutoFlush = $true
$writer.WriteLine('{"ready":true}')
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  $writer.WriteLine([FluxShellFiles]::Handle($line))
}
} catch {
$failure = $_.Exception
while ($failure.InnerException) { $failure = $failure.InnerException }
[Console]::Error.WriteLine(('FLUX_SHELL_HOST_FAILED:{0}:{1:X8}' -f $failure.GetType().Name, $failure.HResult))
# Текст ошибки сборки C# нужен только журналу диагностики и проверке на CI: человеку он не показывается.
[Console]::Error.WriteLine('FLUX_SHELL_HOST_MESSAGE:' + ($failure.Message -replace '\\r?\\n', ' | '))
exit 1
}
`;
