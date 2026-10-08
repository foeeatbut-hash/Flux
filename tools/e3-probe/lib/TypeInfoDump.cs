// Опись COM-интерфейса через IDispatch -> ITypeInfo -> ITypeLib.
// Компилируется Add-Type в Windows PowerShell 5.1, поэтому только C# 5:
// без ?., без интерполяции строк, без out var.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Web.Script.Serialization;
// Псевдонимы: в Mono одни и те же типы есть и в InteropServices, и в ComTypes; в .NET Framework — только в ComTypes.
using TYPEDESC = System.Runtime.InteropServices.ComTypes.TYPEDESC;
using TYPEKIND = System.Runtime.InteropServices.ComTypes.TYPEKIND;
using PARAMFLAG = System.Runtime.InteropServices.ComTypes.PARAMFLAG;
using FUNCDESC = System.Runtime.InteropServices.ComTypes.FUNCDESC;
using TYPEATTR = System.Runtime.InteropServices.ComTypes.TYPEATTR;
using ELEMDESC = System.Runtime.InteropServices.ComTypes.ELEMDESC;
using VARDESC = System.Runtime.InteropServices.ComTypes.VARDESC;
using VARKIND = System.Runtime.InteropServices.ComTypes.VARKIND;
using INVOKEKIND = System.Runtime.InteropServices.ComTypes.INVOKEKIND;
using TYPELIBATTR = System.Runtime.InteropServices.ComTypes.TYPELIBATTR;
using ITypeInfo = System.Runtime.InteropServices.ComTypes.ITypeInfo;
using ITypeLib = System.Runtime.InteropServices.ComTypes.ITypeLib;

public static class FluxTypeInfo {
  [ComImport, Guid("00020400-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDispatchRaw {
    [PreserveSig] int GetTypeInfoCount(out uint pctinfo);
    [PreserveSig] int GetTypeInfo(uint iTInfo, uint lcid, out IntPtr ppTInfo);
    [PreserveSig] int GetIDsOfNames(ref Guid riid, [MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.LPWStr)] string[] rgszNames, uint cNames, uint lcid, [Out, MarshalAs(UnmanagedType.LPArray)] int[] rgDispId);
    [PreserveSig] int Invoke(int dispIdMember, ref Guid riid, uint lcid, ushort wFlags, IntPtr pDispParams, IntPtr pVarResult, IntPtr pExcepInfo, IntPtr puArgErr);
  }

  [DllImport("oleaut32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void LoadTypeLibEx(string fileName, int regKind, out ITypeLib typeLib);

  /// <summary>Файл, куда пишутся метки хода: при зависании последняя строка называет тип или объект, на котором встали.</summary>
  public static string TracePath;

  static void Trace(string text) {
    if (string.IsNullOrEmpty(TracePath)) return;
    try { System.IO.File.AppendAllText(TracePath, DateTime.Now.ToString("HH:mm:ss.fff") + " [типы] " + text + "\r\n", new UTF8Encoding(true)); } catch (Exception) { }
  }

  static readonly string[] Skip = new string[] { "QueryInterface", "AddRef", "Release", "GetTypeInfoCount", "GetTypeInfo", "GetIDsOfNames", "Invoke" };

  static ITypeInfo TypeInfoOf(object com) {
    IDispatchRaw dispatch = com as IDispatchRaw;
    if (dispatch == null) throw new InvalidOperationException("Объект не поддерживает IDispatch");
    uint count; int hr = dispatch.GetTypeInfoCount(out count);
    if (hr < 0 || count == 0) throw new InvalidOperationException("У объекта нет библиотеки типов (GetTypeInfoCount=0)");
    IntPtr raw; hr = dispatch.GetTypeInfo(0, 0, out raw);
    if (hr < 0 || raw == IntPtr.Zero) throw new InvalidOperationException("GetTypeInfo вернул HRESULT 0x" + hr.ToString("X8"));
    try { return (ITypeInfo)Marshal.GetObjectForIUnknown(raw); } finally { Marshal.Release(raw); }
  }

  static string VtName(int vt) {
    switch (vt) {
      case 0: return "empty"; case 1: return "null"; case 2: return "short"; case 3: return "long"; case 4: return "float";
      case 5: return "double"; case 6: return "currency"; case 7: return "date"; case 8: return "BSTR"; case 9: return "IDispatch*";
      case 10: return "error"; case 11: return "bool"; case 12: return "VARIANT"; case 13: return "IUnknown*"; case 14: return "decimal";
      case 16: return "char"; case 17: return "byte"; case 18: return "ushort"; case 19: return "ulong"; case 20: return "int64";
      case 21: return "uint64"; case 22: return "int"; case 23: return "uint"; case 24: return "void"; case 25: return "HRESULT";
      case 30: return "LPSTR"; case 31: return "LPWSTR";
    }
    return "vt" + vt;
  }

  static string TypeName(ITypeInfo owner, TYPEDESC desc, int depth) {
    if (depth > 6) return "?";
    int vt = desc.vt;
    if (vt == 26) { // VT_PTR
      TYPEDESC inner = (TYPEDESC)Marshal.PtrToStructure(desc.lpValue, typeof(TYPEDESC));
      return TypeName(owner, inner, depth + 1) + "*";
    }
    if (vt == 27) { // VT_SAFEARRAY
      TYPEDESC inner = (TYPEDESC)Marshal.PtrToStructure(desc.lpValue, typeof(TYPEDESC));
      return "SAFEARRAY(" + TypeName(owner, inner, depth + 1) + ")";
    }
    if (vt == 28) return "C-array";
    if (vt == 29) { // VT_USERDEFINED
      try {
        ITypeInfo target; owner.GetRefTypeInfo(unchecked((int)(long)desc.lpValue), out target);
        string name, doc, file; int ctx; target.GetDocumentation(-1, out name, out doc, out ctx, out file);
        return name;
      } catch (Exception) { return "userdefined"; }
    }
    return VtName(vt);
  }

  static string KindName(TYPEKIND kind) {
    switch (kind) {
      case TYPEKIND.TKIND_ENUM: return "enum"; case TYPEKIND.TKIND_RECORD: return "record"; case TYPEKIND.TKIND_MODULE: return "module";
      case TYPEKIND.TKIND_INTERFACE: return "interface"; case TYPEKIND.TKIND_DISPATCH: return "dispinterface";
      case TYPEKIND.TKIND_COCLASS: return "coclass"; case TYPEKIND.TKIND_ALIAS: return "alias"; case TYPEKIND.TKIND_UNION: return "union";
    }
    return kind.ToString();
  }

  static string ParamFlags(PARAMFLAG flags) {
    List<string> parts = new List<string>();
    if ((flags & PARAMFLAG.PARAMFLAG_FIN) != 0) parts.Add("in");
    if ((flags & PARAMFLAG.PARAMFLAG_FOUT) != 0) parts.Add("out");
    if ((flags & PARAMFLAG.PARAMFLAG_FRETVAL) != 0) parts.Add("retval");
    if ((flags & PARAMFLAG.PARAMFLAG_FOPT) != 0) parts.Add("optional");
    if ((flags & PARAMFLAG.PARAMFLAG_FHASDEFAULT) != 0) parts.Add("default");
    return string.Join(",", parts.ToArray());
  }

  static Dictionary<string, object> Member(ITypeInfo info, IntPtr funcPtr, FUNCDESC func) {
    string[] names = new string[func.cParams + 1]; int got;
    info.GetNames(func.memid, names, names.Length, out got);
    string doc = "", dummy2 = ""; int ctx;
    string memberName = names[0];
    try { info.GetDocumentation(func.memid, out memberName, out doc, out ctx, out dummy2); } catch (Exception) { }
    string kind = "method";
    if (func.invkind == INVOKEKIND.INVOKE_PROPERTYGET) kind = "propget";
    else if (func.invkind == INVOKEKIND.INVOKE_PROPERTYPUT) kind = "propput";
    else if (func.invkind == INVOKEKIND.INVOKE_PROPERTYPUTREF) kind = "propputref";
    List<object> parameters = new List<object>();
    int size = Marshal.SizeOf(typeof(ELEMDESC));
    for (int i = 0; i < func.cParams; i++) {
      IntPtr at = new IntPtr(func.lprgelemdescParam.ToInt64() + (long)i * size);
      ELEMDESC element = (ELEMDESC)Marshal.PtrToStructure(at, typeof(ELEMDESC));
      Dictionary<string, object> p = new Dictionary<string, object>();
      p["name"] = (i + 1 < got && names[i + 1] != null) ? names[i + 1] : "arg" + (i + 1);
      p["type"] = TypeName(info, element.tdesc, 0);
      p["flags"] = ParamFlags(element.desc.paramdesc.wParamFlags);
      parameters.Add(p);
    }
    Dictionary<string, object> m = new Dictionary<string, object>();
    m["name"] = memberName; m["kind"] = kind; m["memid"] = func.memid;
    m["returns"] = TypeName(info, func.elemdescFunc.tdesc, 0);
    m["params"] = parameters; m["optionalParams"] = (int)func.cParamsOpt; m["doc"] = doc ?? "";
    return m;
  }

  static Dictionary<string, object> Describe(ITypeInfo info) {
    Dictionary<string, object> t = new Dictionary<string, object>();
    string name, doc, file; int ctx;
    info.GetDocumentation(-1, out name, out doc, out ctx, out file);
    Trace("тип " + name);
    IntPtr attrPtr; info.GetTypeAttr(out attrPtr);
    List<object> members = new List<object>();
    List<object> values = new List<object>();
    try {
      TYPEATTR attr = (TYPEATTR)Marshal.PtrToStructure(attrPtr, typeof(TYPEATTR));
      t["name"] = name; t["doc"] = doc ?? ""; t["kind"] = KindName(attr.typekind); t["guid"] = attr.guid.ToString("B");
      t["flags"] = attr.wTypeFlags.ToString();
      for (int i = 0; i < attr.cFuncs; i++) {
        IntPtr funcPtr; info.GetFuncDesc(i, out funcPtr);
        try {
          FUNCDESC func = (FUNCDESC)Marshal.PtrToStructure(funcPtr, typeof(FUNCDESC));
          Dictionary<string, object> member = Member(info, funcPtr, func);
          if (Array.IndexOf(Skip, (string)member["name"]) < 0) members.Add(member);
        } catch (Exception failure) { members.Add(new Dictionary<string, object> { { "name", "#" + i }, { "error", failure.Message } }); }
        finally { info.ReleaseFuncDesc(funcPtr); }
      }
      for (int i = 0; i < attr.cVars; i++) {
        IntPtr varPtr; info.GetVarDesc(i, out varPtr);
        try {
          VARDESC variable = (VARDESC)Marshal.PtrToStructure(varPtr, typeof(VARDESC));
          string[] names = new string[1]; int got; info.GetNames(variable.memid, names, 1, out got);
          Dictionary<string, object> v = new Dictionary<string, object>();
          v["name"] = names[0];
          if (variable.varkind == VARKIND.VAR_CONST && variable.desc.lpvarValue != IntPtr.Zero) {
            try { v["value"] = Marshal.GetObjectForNativeVariant(variable.desc.lpvarValue); } catch (Exception) { }
          }
          values.Add(v);
        } catch (Exception) { } finally { info.ReleaseVarDesc(varPtr); }
      }
    } finally { info.ReleaseTypeAttr(attrPtr); }
    t["members"] = members; t["values"] = values;
    return t;
  }

  static Dictionary<string, object> LibraryOf(ITypeInfo info, bool whole, out List<string> kinds) {
    kinds = new List<string>();
    ITypeLib lib; int index; info.GetContainingTypeLib(out lib, out index);
    return LibraryOfLib(lib, whole);
  }

  static Dictionary<string, object> LibraryOfLib(ITypeLib lib, bool whole) {
    string name, doc, file; int ctx; lib.GetDocumentation(-1, out name, out doc, out ctx, out file);
    Dictionary<string, object> result = new Dictionary<string, object>();
    result["name"] = name; result["doc"] = doc ?? ""; result["helpFile"] = file ?? "";
    IntPtr libPtr; lib.GetLibAttr(out libPtr);
    try {
      TYPELIBATTR a = (TYPELIBATTR)Marshal.PtrToStructure(libPtr, typeof(TYPELIBATTR));
      result["guid"] = a.guid.ToString("B"); result["version"] = a.wMajorVerNum + "." + a.wMinorVerNum;
    } finally { lib.ReleaseTLibAttr(libPtr); }
    int count = lib.GetTypeInfoCount();
    result["typeCount"] = count;
    List<object> types = new List<object>();
    if (whole) {
      for (int i = 0; i < count; i++) {
        Trace("библиотека: тип " + (i + 1) + " из " + count);
        try { ITypeInfo each; lib.GetTypeInfo(i, out each); types.Add(Describe(each)); }
        catch (Exception failure) { types.Add(new Dictionary<string, object> { { "name", "#" + i }, { "error", failure.Message } }); }
      }
    }
    result["types"] = types;
    return result;
  }

  static void Line(StringBuilder text, Dictionary<string, object> member) {
    List<string> ps = new List<string>();
    foreach (object o in (List<object>)member["params"]) {
      Dictionary<string, object> p = (Dictionary<string, object>)o;
      string flags = (string)p["flags"];
      ps.Add(p["type"] + " " + p["name"] + (flags.Length > 0 ? " [" + flags + "]" : ""));
    }
    string prefix = (string)member["kind"] == "method" ? "" : "(" + member["kind"] + ") ";
    text.Append("  ").Append(prefix).Append(member["returns"]).Append(' ').Append(member["name"]).Append('(').Append(string.Join(", ", ps.ToArray())).Append(')');
    string doc = (string)member["doc"]; if (doc.Length > 0) text.Append("   // ").Append(doc);
    text.AppendLine();
  }

  static void Render(StringBuilder text, Dictionary<string, object> type) {
    text.AppendLine().Append(type["kind"]).Append(' ').Append(type["name"]).Append(' ').AppendLine((string)type["guid"]);
    string doc = (string)type["doc"]; if (doc.Length > 0) text.Append("  // ").AppendLine(doc);
    foreach (object o in (List<object>)type["members"]) {
      Dictionary<string, object> m = (Dictionary<string, object>)o;
      if (m.ContainsKey("error")) { text.Append("  ! ").Append(m["name"]).Append(": ").AppendLine((string)m["error"]); continue; }
      Line(text, m);
    }
    foreach (object o in (List<object>)type["values"]) {
      Dictionary<string, object> v = (Dictionary<string, object>)o;
      text.Append("  ").Append(v["name"]);
      if (v.ContainsKey("value")) text.Append(" = ").Append(v["value"]);
      text.AppendLine();
    }
  }

  static string Json(object tree) {
    JavaScriptSerializer serializer = new JavaScriptSerializer(); serializer.MaxJsonLength = int.MaxValue; serializer.RecursionLimit = 64;
    return serializer.Serialize(tree);
  }

  /// <summary>Описание типа самого объекта. Возврат: [0] — JSON, [1] — текст, [2] — имена членов через перевод строки.</summary>
  public static string[] OfObject(object com, string label) {
    Trace("опись объекта " + label + ": запрашиваю ITypeInfo у живого объекта");
    ITypeInfo info = TypeInfoOf(com);
    Dictionary<string, object> type = Describe(info);
    List<string> unused; Dictionary<string, object> lib = LibraryOf(info, false, out unused);
    Dictionary<string, object> tree = new Dictionary<string, object>();
    tree["label"] = label; tree["library"] = lib; tree["type"] = type;
    StringBuilder text = new StringBuilder();
    text.Append("Объект: ").AppendLine(label);
    text.Append("Библиотека типов: ").Append(lib["name"]).Append(' ').Append(lib["guid"]).Append(" v").AppendLine((string)lib["version"]);
    Render(text, type);
    List<string> names = new List<string>();
    foreach (object o in (List<object>)type["members"]) { Dictionary<string, object> m = (Dictionary<string, object>)o; if (m.ContainsKey("name") && !names.Contains((string)m["name"])) names.Add((string)m["name"]); }
    return new string[] { Json(tree), text.ToString(), string.Join("\n", names.ToArray()) };
  }

  /// <summary>Вся библиотека типов, к которой относится объект: все интерфейсы, классы, перечисления. [0] — JSON, [1] — текст.</summary>
  public static string[] Library(object com, string label) {
    ITypeInfo info = TypeInfoOf(com);
    List<string> unused; Dictionary<string, object> lib = LibraryOf(info, true, out unused);
    return LibraryDocument(lib, label);
  }

  /// <summary>Та же библиотека, но из файла на диске (.tlb, .dll): без единого вызова в запущенную программу. Через ITypeInfo
  /// живого объекта каждое обращение уходит в процесс E3, и опись всей библиотеки — тысячи таких вызовов.</summary>
  public static string[] LibraryFile(string path, string label) {
    ITypeLib typeLib; LoadTypeLibEx(path, 2, out typeLib); // 2 = REGKIND_NONE: реестр не трогаем
    Dictionary<string, object> lib = LibraryOfLib(typeLib, true);
    return LibraryDocument(lib, label);
  }

  static string[] LibraryDocument(Dictionary<string, object> lib, string label) {
    StringBuilder text = new StringBuilder();
    text.Append("Библиотека типов: ").Append(lib["name"]).Append(' ').Append(lib["guid"]).Append(" v").Append((string)lib["version"]).Append(" (получена через ").Append(label).AppendLine(")");
    foreach (object o in (List<object>)lib["types"]) {
      Dictionary<string, object> t = (Dictionary<string, object>)o;
      if (t.ContainsKey("error")) { text.Append("! ").Append(t["name"]).Append(": ").AppendLine((string)t["error"]); continue; }
      Render(text, t);
    }
    return new string[] { Json(lib), text.ToString() };
  }
}
