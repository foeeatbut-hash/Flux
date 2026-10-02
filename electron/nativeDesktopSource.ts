/** Код помощника фиксирован: имена и PIDL от renderer не становятся программой. */
export const NATIVE_DESKTOP_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Web.Script.Serialization;

public static class FluxExplorerDesktop {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Size { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] public struct BitmapHeader {
    public uint size; public int width, height; public ushort planes, bits;
    public uint compression, imageSize; public int xPixels, yPixels; public uint used, important;
  }
  [StructLayout(LayoutKind.Sequential)] public struct BitmapInfo { public BitmapHeader header; public uint color; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct ExecuteInfo {
    public int cbSize; public uint fMask; public IntPtr hwnd;
    public string verb, file, parameters, directory; public int show;
    public IntPtr instance, pidl; public string className; public IntPtr classKey;
    public uint hotKey; public IntPtr icon, process;
  }
  [ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IServiceProvider { [PreserveSig] int QueryService(ref Guid service, ref Guid iid, out IntPtr result); }
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OutPointer(IntPtr self, out IntPtr value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OutNumber(IntPtr self, uint flags, out int value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ItemPidl(IntPtr self, int index, out IntPtr value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ItemObject(IntPtr self, int index, ref Guid iid, out IntPtr value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ItemPoint(IntPtr self, IntPtr pidl, out Point value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OutPoint(IntPtr self, out Point value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OutMode(IntPtr self, out uint mode, out int size);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OutFlags(IntPtr self, out uint flags);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ItemName(IntPtr self, uint display, out IntPtr name);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ItemAttributes(IntPtr self, uint mask, out uint attributes);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ItemImage(IntPtr self, Size size, uint flags, out IntPtr bitmap);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] static extern bool LogicalToPhysicalPointForPerMonitorDPI(IntPtr window, ref Point point);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string title);
  [DllImport("shell32.dll")] static extern uint ILGetSize(IntPtr pidl);
  [DllImport("shell32.dll")] static extern int SHGetIDListFromObject(IntPtr item, out IntPtr pidl);
  [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(ref Guid folder, uint flags, IntPtr token, out IntPtr path);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ShellExecuteEx(ref ExecuteInfo info);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr bitmap);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr dc, IntPtr bitmap, uint start, uint lines, byte[] pixels, ref BitmapInfo info, uint usage);

  static T Method<T>(IntPtr instance, int slot) where T : class {
    IntPtr table = Marshal.ReadIntPtr(instance);
    return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table, slot * IntPtr.Size), typeof(T)) as T;
  }
  static void Check(int hr) { if (hr < 0) Marshal.ThrowExceptionForHR(hr); }
  static string Key(IntPtr pidl) {
    int size = checked((int)ILGetSize(pidl));
    if (size < 2 || size > 65536) throw new InvalidDataException("PIDL_SIZE");
    byte[] bytes = new byte[size]; Marshal.Copy(pidl, bytes, 0, size);
    using (SHA256 sha = SHA256.Create()) return Convert.ToBase64String(sha.ComputeHash(bytes));
  }
  static Point ToPhysical(IntPtr window, Point local) {
    IntPtr previous = SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(window));
    try {
      if (!ClientToScreen(window, ref local) || !LogicalToPhysicalPointForPerMonitorDPI(window, ref local))
        throw new InvalidOperationException("DESKTOP_COORDINATES");
      return local;
    } finally { SetThreadDpiAwarenessContext(previous); }
  }
  static Dictionary<string,object> Image(IntPtr item, int size) {
    IntPtr image = IntPtr.Zero, bitmap = IntPtr.Zero;
    try {
      Guid iid = new Guid("BCC18B79-BA16-442F-80C4-8A59C30C463B");
      Check(Marshal.QueryInterface(item, ref iid, out image));
      // Десктоп может показывать миниатюру: ICONONLY изменил бы его изображение.
      Check(Method<ItemImage>(image, 3)(image, new Size { x=size, y=size }, 0, out bitmap));
      // FromHbitmap теряет alpha и рисует чёрный квадрат вокруг прозрачного значка.
      IntPtr dc=CreateCompatibleDC(IntPtr.Zero);
      try {
        BitmapInfo info = new BitmapInfo(); info.header.size=40;
        if (GetDIBits(dc, bitmap, 0, 0, null, ref info, 0) == 0) throw new InvalidOperationException("ICON_HEADER");
        int width=info.header.width, height=Math.Abs(info.header.height);
        if (width < 1 || height < 1 || width > 2048 || height > 2048) throw new InvalidDataException("ICON_DIMENSIONS");
        info.header.height=-height; info.header.planes=1; info.header.bits=32; info.header.compression=0;
        byte[] pixels=new byte[checked(width*height*4)];
        if (GetDIBits(dc, bitmap, 0, (uint)height, pixels, ref info, 0) != height) throw new InvalidOperationException("ICON_PIXELS");
        bool alpha=false; for (int i=3;i<pixels.Length;i+=4) if (pixels[i]!=0) { alpha=true; break; }
        if (!alpha) for (int i=3;i<pixels.Length;i+=4) pixels[i]=255;
        using (Bitmap picture=new Bitmap(width,height,PixelFormat.Format32bppPArgb))
        using (MemoryStream bytes=new MemoryStream()) {
          BitmapData data=picture.LockBits(new Rectangle(0,0,width,height),ImageLockMode.WriteOnly,PixelFormat.Format32bppPArgb);
          try { Marshal.Copy(pixels,0,data.Scan0,pixels.Length); } finally { picture.UnlockBits(data); }
          picture.Save(bytes,ImageFormat.Png);
          return new Dictionary<string,object> { {"base64",Convert.ToBase64String(bytes.ToArray())}, {"width",width}, {"height",height} };
        }
      } finally { if (dc!=IntPtr.Zero) DeleteDC(dc); }
    } catch { return null; }
    finally { if (bitmap != IntPtr.Zero) DeleteObject(bitmap); if (image != IntPtr.Zero) Marshal.Release(image); }
  }
  public static string Run(string action, string requestedKey) {
    if (System.Threading.Thread.CurrentThread.GetApartmentState() != System.Threading.ApartmentState.STA)
      throw new InvalidOperationException("DESKTOP_STA_REQUIRED");
    if (action == "public-desktop") {
      Guid folder = new Guid("C4AA340D-F20F-4863-AFEF-F87EF2E6BA25"); IntPtr path = IntPtr.Zero;
      try { Check(SHGetKnownFolderPath(ref folder, 0, IntPtr.Zero, out path)); return new JavaScriptSerializer().Serialize(new Dictionary<string,object>{{"path",Marshal.PtrToStringUni(path)}}); }
      finally { if (path != IntPtr.Zero) Marshal.FreeCoTaskMem(path); }
    }
    if (action != "snapshot" && action != "open") throw new InvalidOperationException("DESKTOP_ACTION");
    object windows = null, dispatch = null;
    IntPtr browser=IntPtr.Zero, view=IntPtr.Zero, folderView=IntPtr.Zero;
    IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      windows = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("9BA05972-F6A8-11CF-A442-00A0C90A8F39")));
      object[] args = new object[] { 0, null, 8, 0, 1 };
      ParameterModifier modifier = new ParameterModifier(5); modifier[0]=true; modifier[1]=true; modifier[3]=true;
      dispatch = windows.GetType().InvokeMember("FindWindowSW", BindingFlags.InvokeMethod, null, windows, args, new ParameterModifier[] { modifier }, null, null);
      if (dispatch == null) throw new InvalidOperationException("EXPLORER_DESKTOP_UNAVAILABLE");
      Guid service = new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837"), browserId = new Guid("000214E2-0000-0000-C000-000000000046");
      Check(((IServiceProvider)dispatch).QueryService(ref service, ref browserId, out browser));
      // Номера соответствуют vtable Windows SDK: IOleWindow + IShellBrowser.
      Check(Method<OutPointer>(browser, 15)(browser, out view));
      Guid folderId = new Guid("1AF3A467-214F-4298-908E-06B03E0B39F9");
      Check(Marshal.QueryInterface(view, ref folderId, out folderView));
      IntPtr window; Check(Method<OutPointer>(view, 3)(view, out window));
      uint mode, flags; int iconSize;
      // IFolderView содержит 14 методов; GetViewModeAndIconSize — слот 36.
      Check(Method<OutMode>(folderView, 36)(folderView, out mode, out iconSize));
      Check(Method<OutFlags>(folderView, 25)(folderView, out flags));
      if (iconSize < 8 || iconSize > 1024) throw new InvalidDataException("DESKTOP_ICON_SIZE");
      Point spacing; Check(Method<OutPoint>(folderView, 12)(folderView, out spacing));
      Rect bounds; if (!GetClientRect(window, out bounds)) throw new InvalidOperationException("DESKTOP_BOUNDS");
      Point origin = ToPhysical(window, new Point { x=bounds.left, y=bounds.top });
      Point end = ToPhysical(window, new Point { x=bounds.right, y=bounds.bottom });
      IntPtr list = FindWindowEx(window, IntPtr.Zero, "SysListView32", null);
      bool visible = (flags & 0x1000) == 0 && IsWindowVisible(list == IntPtr.Zero ? window : list);
      int count; Check(Method<OutNumber>(folderView, 7)(folderView, 2, out count));
      if (count < 0 || count > 10000) throw new InvalidDataException("DESKTOP_ITEM_COUNT");
      List<object> items = new List<object>(); int skipped=0;
      Guid itemId = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
      for (int index=0; index<count; index++) {
        IntPtr child=IntPtr.Zero, item=IntPtr.Zero, name=IntPtr.Zero, absolute=IntPtr.Zero;
        try {
          Check(Method<ItemPidl>(folderView, 6)(folderView, index, out child));
          string key = Key(child);
          if (action == "open" && key != requestedKey) continue;
          Check(Method<ItemObject>(folderView, 29)(folderView, index, ref itemId, out item));
          if (action == "open") {
            Check(SHGetIDListFromObject(item, out absolute));
            ExecuteInfo execute = new ExecuteInfo { cbSize=Marshal.SizeOf(typeof(ExecuteInfo)), fMask=0x4 | 0x400, pidl=absolute, show=1 };
            if (!ShellExecuteEx(ref execute)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return "{\"opened\":true}";
          }
          Point position; Check(Method<ItemPoint>(folderView, 11)(folderView, child, out position));
          position = ToPhysical(window, position);
          Check(Method<ItemName>(item, 5)(item, 0, out name));
          uint attributes; Check(Method<ItemAttributes>(item, 6)(item, 0x60010000, out attributes));
          string kind = (attributes & 0x40000000) == 0 ? "virtual" : (attributes & 0x10000) != 0 ? "shortcut" : (attributes & 0x20000000) != 0 ? "directory" : "file";
          string fileSystemPath = null;
          // SIGDN_FILESYSPATH приходит только в main; ярлык сохраняет Shell-активацию.
          if (kind == "file" || kind == "directory") {
            IntPtr path = IntPtr.Zero;
            try { Check(Method<ItemName>(item, 5)(item, 0x80058000, out path)); fileSystemPath=Marshal.PtrToStringUni(path); }
            finally { if (path != IntPtr.Zero) Marshal.FreeCoTaskMem(path); }
          }
          items.Add(new Dictionary<string,object> { {"nativeId",key}, {"name",Marshal.PtrToStringUni(name)}, {"kind",kind}, {"x",position.x}, {"y",position.y}, {"icon",Image(item,iconSize)}, {"fileSystemPath",fileSystemPath} });
        } catch { if (action == "open") throw; skipped++; }
        finally {
          if (absolute != IntPtr.Zero) Marshal.FreeCoTaskMem(absolute);
          if (name != IntPtr.Zero) Marshal.FreeCoTaskMem(name);
          if (item != IntPtr.Zero) Marshal.Release(item);
          if (child != IntPtr.Zero) Marshal.FreeCoTaskMem(child);
        }
      }
      if (action == "open") throw new InvalidOperationException("DESKTOP_ITEM_CHANGED");
      Dictionary<string,object> result = new Dictionary<string,object> {
        {"items",items}, {"skipped",skipped}, {"iconSize",iconSize}, {"spacing",new Dictionary<string,object>{{"x",spacing.x},{"y",spacing.y}}},
        {"iconsVisible",visible}, {"physicalBounds",new Dictionary<string,object>{{"x",origin.x},{"y",origin.y},{"width",end.x-origin.x},{"height",end.y-origin.y}}}
      };
      JavaScriptSerializer json = new JavaScriptSerializer(); json.MaxJsonLength=32*1024*1024; return json.Serialize(result);
    } finally {
      if (folderView != IntPtr.Zero) Marshal.Release(folderView);
      if (view != IntPtr.Zero) Marshal.Release(view);
      if (browser != IntPtr.Zero) Marshal.Release(browser);
      if (dispatch != null && Marshal.IsComObject(dispatch)) Marshal.ReleaseComObject(dispatch);
      if (windows != null && Marshal.IsComObject(windows)) Marshal.ReleaseComObject(windows);
      SetThreadDpiAwarenessContext(previous);
    }
  }
}
`;

export const NATIVE_DESKTOP_SCRIPT = `$ErrorActionPreference = 'Stop'
try {
Add-Type -ReferencedAssemblies System.Drawing,System.Web.Extensions -TypeDefinition @'
${NATIVE_DESKTOP_SOURCE}
'@
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::WriteLine([FluxExplorerDesktop]::Run($env:FLUX_DESKTOP_ACTION, $env:FLUX_DESKTOP_ITEM))
} catch {
[Console]::Error.WriteLine('FLUX_DESKTOP_NATIVE_FAILED')
exit 1
}
`;
