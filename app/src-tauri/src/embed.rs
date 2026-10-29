//! Embedded BlueStacks view (experimental, behind the `embedView` setting).
//!
//! A pod's BlueStacks window (HD-Player, title `wa-<pod>`) is re-parented into the app window as a child, stripped of
//! its caption and borders, moved to the rectangle of the placeholder the UI measured, and hidden/shown when tabs
//! switch. Everything is restored (top-level, original style and position) when the tab is closed or the app exits,
//! so BlueStacks never dies with the app window.
//!
//! The rules (styles, scaling, window choice, bookkeeping) are pure and tested here against a fake `WinApi`;
//! `RealWin` is the user32 implementation and is exercised with dummy windows (never with a real pod in the tests).

use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Mutex;

pub const WS_POPUP: u32 = 0x8000_0000;
pub const WS_CHILD: u32 = 0x4000_0000;
pub const WS_VISIBLE: u32 = 0x1000_0000;
pub const WS_CLIPSIBLINGS: u32 = 0x0400_0000;
pub const WS_CLIPCHILDREN: u32 = 0x0200_0000;
pub const WS_CAPTION: u32 = 0x00C0_0000; // WS_BORDER | WS_DLGFRAME
pub const WS_SYSMENU: u32 = 0x0008_0000;
pub const WS_THICKFRAME: u32 = 0x0004_0000;
pub const WS_MINIMIZEBOX: u32 = 0x0002_0000;
pub const WS_MAXIMIZEBOX: u32 = 0x0001_0000;
pub const WS_EX_DLGMODALFRAME: u32 = 0x0000_0001;
pub const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
pub const WS_EX_WINDOWEDGE: u32 = 0x0000_0100;
pub const WS_EX_CLIENTEDGE: u32 = 0x0000_0200;
pub const WS_EX_APPWINDOW: u32 = 0x0004_0000;

/// Style of the window once embedded: a plain child, no caption, borders, resize frame or system buttons.
pub fn embedded_style(style: u32) -> u32 {
    let stripped = style & !(WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
    stripped | WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN
}

pub fn embedded_ex_style(ex_style: u32) -> u32 {
    ex_style & !(WS_EX_APPWINDOW | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_DLGMODALFRAME | WS_EX_TOOLWINDOW)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// CSS pixels (what the UI measures) -> physical pixels (what Win32 wants), never negative and at least 1x1.
pub fn scale_rect(x: f64, y: f64, width: f64, height: f64, dpr: f64) -> Rect {
    let dpr = if dpr.is_finite() && dpr > 0.0 { dpr } else { 1.0 };
    let px = |v: f64| if v.is_finite() { (v * dpr).round() as i32 } else { 0 };
    Rect { x: px(x).max(0), y: px(y).max(0), w: px(width).max(1), h: px(height).max(1) }
}

#[derive(Clone, Debug, PartialEq)]
pub struct WindowInfo {
    pub hwnd: isize,
    pub title: String,
    pub exe: String,
    pub visible: bool,
}

/// The pod window among all top-level windows: exact title (case-insensitive), a BlueStacks player process, preferring
/// a visible one. `exe_contains` is lower case; `None` skips the process check (tests with dummy windows).
pub fn pick_window(windows: &[WindowInfo], title: &str, exe_contains: Option<&str>) -> Option<isize> {
    let matches = |w: &&WindowInfo| {
        w.title.eq_ignore_ascii_case(title) && exe_contains.is_none_or(|needle| w.exe.to_ascii_lowercase().contains(needle))
    };
    let found: Vec<&WindowInfo> = windows.iter().filter(matches).collect();
    found.iter().find(|w| w.visible).or(found.first()).map(|w| w.hwnd)
}

pub fn pod_window_title(pod_name: &str) -> String {
    format!("wa-{pod_name}")
}

/// What a window looked like before we embedded it.
#[derive(Clone, Debug, PartialEq)]
pub struct Original {
    pub style: u32,
    pub ex_style: u32,
    pub rect: Rect,
}

pub trait WinApi {
    fn find_window(&self, title: &str) -> Option<isize>;
    fn is_window(&self, hwnd: isize) -> bool;
    fn snapshot(&self, hwnd: isize) -> Result<Original, String>;
    /// Restyle as a child, re-parent under `parent`, place at `rect` and show it.
    fn embed(&self, hwnd: isize, parent: isize, style: u32, ex_style: u32, rect: Rect) -> Result<(), String>;
    fn place(&self, hwnd: isize, rect: Rect) -> Result<(), String>;
    fn set_visible(&self, hwnd: isize, visible: bool);
    /// Back to a top-level window with its original style and position.
    fn restore(&self, hwnd: isize, original: &Original) -> Result<(), String>;
    fn focus(&self, hwnd: isize);
}

struct Attached {
    hwnd: isize,
    original: Original,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EmbedState {
    pub attached: Vec<String>,
    pub active: Option<String>,
}

pub struct Embedder<A: WinApi> {
    api: A,
    parent: isize,
    attached: Mutex<BTreeMap<String, Attached>>,
    active: Mutex<Option<String>>,
}

impl<A: WinApi> Embedder<A> {
    pub fn new(api: A, parent: isize) -> Embedder<A> {
        Embedder { api, parent, attached: Mutex::new(BTreeMap::new()), active: Mutex::new(None) }
    }

    pub fn state(&self) -> EmbedState {
        EmbedState { attached: self.attached.lock().unwrap().keys().cloned().collect(), active: self.active.lock().unwrap().clone() }
    }

    /// Embeds the pod's window at `rect` (or just moves it when it is already embedded). The first call remembers the
    /// original look so `detach` can give it back.
    pub fn attach(&self, pod: &str, rect: Rect) -> Result<(), String> {
        let mut attached = self.attached.lock().unwrap();
        if let Some(existing) = attached.get(pod) {
            if self.api.is_window(existing.hwnd) {
                return self.api.place(existing.hwnd, rect);
            }
            attached.remove(pod); // the window was closed: embed the new one
        }
        let hwnd = self
            .api
            .find_window(&pod_window_title(pod))
            .ok_or_else(|| format!("No encuentro la ventana de BlueStacks del pod «{pod}». ¿Está encendido?"))?;
        let original = self.api.snapshot(hwnd)?;
        self.api.embed(hwnd, self.parent, embedded_style(original.style), embedded_ex_style(original.ex_style), rect)?;
        attached.insert(pod.to_string(), Attached { hwnd, original });
        Ok(())
    }

    pub fn resize(&self, pod: &str, rect: Rect) -> Result<(), String> {
        let attached = self.attached.lock().unwrap();
        let entry = attached.get(pod).ok_or_else(|| format!("El pod «{pod}» no está en la vista embebida."))?;
        self.api.place(entry.hwnd, rect)
    }

    /// Shows `pod` (if any) and hides every other embedded window. `None` hides them all.
    pub fn activate(&self, pod: Option<&str>) {
        let attached = self.attached.lock().unwrap();
        for (name, entry) in attached.iter() {
            self.api.set_visible(entry.hwnd, pod == Some(name.as_str()));
        }
        *self.active.lock().unwrap() = pod.filter(|p| attached.contains_key(*p)).map(str::to_string);
    }

    /// Gives the window back (top-level, original style and place) and forgets it.
    pub fn detach(&self, pod: &str) -> Result<(), String> {
        let entry = self.attached.lock().unwrap().remove(pod);
        {
            let mut active = self.active.lock().unwrap();
            if active.as_deref() == Some(pod) {
                *active = None;
            }
        }
        let Some(entry) = entry else { return Ok(()) };
        if !self.api.is_window(entry.hwnd) {
            return Ok(());
        }
        self.api.restore(entry.hwnd, &entry.original)?;
        self.api.focus(entry.hwnd);
        Ok(())
    }

    /// Restores everything (app closing). Errors are collected, never stop the rest.
    pub fn detach_all(&self) -> Vec<String> {
        let names: Vec<String> = self.attached.lock().unwrap().keys().cloned().collect();
        names.iter().filter_map(|n| self.detach(n).err()).collect()
    }
}

// ---------- user32 ----------

#[cfg(windows)]
pub mod win {
    use super::{Original, Rect, WinApi, WindowInfo, pick_window};

    const GWL_STYLE: i32 = -16;
    const GWL_EXSTYLE: i32 = -20;
    const SW_HIDE: i32 = 0;
    const SW_SHOW: i32 = 5;
    const SWP_NOZORDER: u32 = 0x0004;
    /// Skip WM_WINDOWPOSCHANGING: BlueStacks (Qt) uses it to force its own geometry back, which sent the re-parented
    /// window thousands of pixels off screen. Without the message our rectangle is applied as asked.
    const SWP_NOSENDCHANGING: u32 = 0x0400;
    /// Above its siblings, in particular above the webview that fills the app window.
    const HWND_TOP: isize = 0;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    #[repr(C)]
    #[derive(Default)]
    struct Rc {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct Pt {
        x: i32,
        y: i32,
    }

    #[cfg(test)]
    unsafe extern "system" {
        fn ClientToScreen(hwnd: isize, point: *mut Pt) -> i32;
    }

    type EnumProc = unsafe extern "system" fn(isize, isize) -> i32;

    unsafe extern "system" {
        fn EnumWindows(proc: EnumProc, lparam: isize) -> i32;
        fn GetWindowTextW(hwnd: isize, text: *mut u16, max: i32) -> i32;
        fn IsWindowVisible(hwnd: isize) -> i32;
        fn IsWindow(hwnd: isize) -> i32;
        fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
        fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
        fn SetParent(child: isize, parent: isize) -> isize;
        fn GetWindowRect(hwnd: isize, rect: *mut Rc) -> i32;
        fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
        fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
        fn SetForegroundWindow(hwnd: isize) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn CloseHandle(handle: isize) -> i32;
        fn QueryFullProcessImageNameW(process: isize, flags: u32, name: *mut u16, size: *mut u32) -> i32;
    }

    #[cfg(test)]
    unsafe extern "system" {
        pub(super) fn CreateWindowExW(ex: u32, class: *const u16, name: *const u16, style: u32, x: i32, y: i32, w: i32, h: i32, parent: isize, menu: isize, instance: isize, param: *const std::ffi::c_void) -> isize;
        pub(super) fn DestroyWindow(hwnd: isize) -> i32;
        pub(super) fn GetParent(hwnd: isize) -> isize;
    }

    fn last_os_error(what: &str) -> String {
        format!("{what}: {}", std::io::Error::last_os_error())
    }

    fn exe_of(hwnd: isize) -> String {
        let mut pid = 0u32;
        // SAFETY: plain Win32 calls with valid out-pointers; the process handle is closed before returning.
        unsafe {
            GetWindowThreadProcessId(hwnd, &mut pid);
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle == 0 {
                return String::new();
            }
            let mut buf = [0u16; 520];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
            CloseHandle(handle);
            if ok == 0 { String::new() } else { String::from_utf16_lossy(&buf[..len as usize]) }
        }
    }

    unsafe extern "system" fn collect(hwnd: isize, lparam: isize) -> i32 {
        // SAFETY: lparam is the address of the Vec passed by `top_level_windows`, alive for the whole EnumWindows call.
        let list = unsafe { &mut *(lparam as *mut Vec<WindowInfo>) };
        let mut buf = [0u16; 256];
        // SAFETY: buf is a valid buffer of the declared length.
        let n = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        if n > 0 {
            list.push(WindowInfo {
                hwnd,
                title: String::from_utf16_lossy(&buf[..n as usize]),
                exe: exe_of(hwnd),
                // SAFETY: hwnd comes straight from EnumWindows.
                visible: unsafe { IsWindowVisible(hwnd) } != 0,
            });
        }
        1
    }

    fn top_level_windows() -> Vec<WindowInfo> {
        let mut list: Vec<WindowInfo> = Vec::new();
        // SAFETY: the callback only writes to `list`, which outlives the call.
        unsafe { EnumWindows(collect, &mut list as *mut Vec<WindowInfo> as isize) };
        list
    }

    /// user32 implementation. `exe_filter` is the lower-case fragment the owning process must contain.
    pub struct RealWin {
        pub exe_filter: Option<&'static str>,
    }

    impl Default for RealWin {
        fn default() -> Self {
            RealWin { exe_filter: Some("hd-player") }
        }
    }

    impl WinApi for RealWin {
        fn find_window(&self, title: &str) -> Option<isize> {
            pick_window(&top_level_windows(), title, self.exe_filter)
        }

        fn is_window(&self, hwnd: isize) -> bool {
            // SAFETY: IsWindow accepts any handle value.
            unsafe { IsWindow(hwnd) != 0 }
        }

        fn snapshot(&self, hwnd: isize) -> Result<Original, String> {
            let mut rc = Rc::default();
            // SAFETY: valid out-pointer; reads window data only.
            unsafe {
                if GetWindowRect(hwnd, &mut rc) == 0 {
                    return Err(last_os_error("No se pudo leer la ventana del pod"));
                }
                Ok(Original {
                    style: GetWindowLongPtrW(hwnd, GWL_STYLE) as u32,
                    ex_style: GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32,
                    rect: Rect { x: rc.left, y: rc.top, w: rc.right - rc.left, h: rc.bottom - rc.top },
                })
            }
        }

        fn embed(&self, hwnd: isize, parent: isize, style: u32, ex_style: u32, rect: Rect) -> Result<(), String> {
            // Order from the SetParent docs: becoming a child means clearing WS_POPUP / setting WS_CHILD BEFORE SetParent.
            // SAFETY: plain Win32 window calls on handles we just looked up.
            unsafe {
                SetWindowLongPtrW(hwnd, GWL_STYLE, style as isize);
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style as isize);
                if SetParent(hwnd, parent) == 0 {
                    return Err(last_os_error("No se pudo meter la ventana del pod en la app"));
                }
                SetWindowPos(hwnd, HWND_TOP, rect.x, rect.y, rect.w, rect.h, SWP_NOSENDCHANGING | SWP_NOACTIVATE | SWP_FRAMECHANGED);
                ShowWindow(hwnd, SW_SHOW);
            }
            Ok(())
        }

        fn place(&self, hwnd: isize, rect: Rect) -> Result<(), String> {
            // SAFETY: plain Win32 call.
            let ok = unsafe { SetWindowPos(hwnd, HWND_TOP, rect.x, rect.y, rect.w, rect.h, SWP_NOSENDCHANGING | SWP_NOACTIVATE) };
            if ok == 0 { Err(last_os_error("No se pudo mover la ventana del pod")) } else { Ok(()) }
        }

        fn set_visible(&self, hwnd: isize, visible: bool) {
            // SAFETY: plain Win32 call.
            unsafe { ShowWindow(hwnd, if visible { SW_SHOW } else { SW_HIDE }) };
        }

        fn restore(&self, hwnd: isize, original: &Original) -> Result<(), String> {
            // For the way back, SetParent(NULL) comes first and the original (WS_POPUP...) style after it.
            // SAFETY: plain Win32 window calls.
            unsafe {
                ShowWindow(hwnd, SW_HIDE);
                SetParent(hwnd, 0);
                SetWindowLongPtrW(hwnd, GWL_STYLE, original.style as isize);
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, original.ex_style as isize);
                let r = original.rect;
                SetWindowPos(hwnd, 0, r.x, r.y, r.w, r.h, SWP_NOZORDER | SWP_NOSENDCHANGING | SWP_NOACTIVATE | SWP_FRAMECHANGED);
                ShowWindow(hwnd, SW_SHOW);
            }
            Ok(())
        }

        fn focus(&self, hwnd: isize) {
            // SAFETY: plain Win32 call.
            unsafe { SetForegroundWindow(hwnd) };
        }
    }

    #[cfg(test)]
    pub(super) mod dummy {
        use super::*;

        #[repr(C)]
        struct WindowPos {
            hwnd: isize,
            insert_after: isize,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        }

        #[repr(C)]
        struct WndClassExW {
            size: u32,
            style: u32,
            proc: unsafe extern "system" fn(isize, u32, usize, isize) -> isize,
            cls_extra: i32,
            wnd_extra: i32,
            instance: isize,
            icon: isize,
            cursor: isize,
            background: isize,
            menu: *const u16,
            class_name: *const u16,
            icon_sm: isize,
        }

        unsafe extern "system" {
            fn RegisterClassExW(class: *const WndClassExW) -> u16;
            fn DefWindowProcW(hwnd: isize, msg: u32, w: usize, l: isize) -> isize;
        }

        /// The geometry BlueStacks (Qt) forces on itself whenever Windows asks to move or size it.
        pub const FORCED: Rect = Rect { x: 777, y: 18000, w: 528, h: 912 };

        /// Behaves like Qt's top-level window: in WM_WINDOWPOSCHANGING it rewrites the requested geometry.
        unsafe extern "system" fn qt_like_proc(hwnd: isize, msg: u32, w: usize, l: isize) -> isize {
            const WM_WINDOWPOSCHANGING: u32 = 0x0046;
            if msg == WM_WINDOWPOSCHANGING {
                // SAFETY: for this message lParam points to a WINDOWPOS owned by the system for the call.
                let pos = unsafe { &mut *(l as *mut WindowPos) };
                pos.x = FORCED.x;
                pos.y = FORCED.y;
                pos.cx = FORCED.w;
                pos.cy = FORCED.h;
                pos.flags &= !(0x0002 | 0x0001); // clear SWP_NOMOVE | SWP_NOSIZE
            }
            // SAFETY: forwarding the untouched message to the default procedure.
            unsafe { DefWindowProcW(hwnd, msg, w, l) }
        }

        /// A top-level popup window whose procedure fights every move, like the real BlueStacks one.
        pub fn qt_like_window(title: &str, rect: Rect) -> isize {
            let class_name = utf16("agentautox1QtLike");
            let class = WndClassExW {
                size: std::mem::size_of::<WndClassExW>() as u32,
                style: 0,
                proc: qt_like_proc,
                cls_extra: 0,
                wnd_extra: 0,
                instance: 0,
                icon: 0,
                cursor: 0,
                background: 0,
                menu: std::ptr::null(),
                class_name: class_name.as_ptr(),
                icon_sm: 0,
            };
            // SAFETY: the class structure is fully initialised; registering twice just fails harmlessly.
            unsafe { RegisterClassExW(&class) };
            let name = utf16(title);
            // WS_POPUP | WS_CLIPSIBLINGS | WS_CLIPCHILDREN | WS_SYSMENU
            let style = 0x8000_0000u32 | 0x0400_0000 | 0x0200_0000 | 0x0008_0000;
            // SAFETY: valid NUL-terminated strings; the caller destroys the window.
            unsafe { CreateWindowExW(0, class_name.as_ptr(), name.as_ptr(), style, rect.x, rect.y, rect.w, rect.h, 0, 0, 0, std::ptr::null()) }
        }

        pub fn utf16(text: &str) -> Vec<u16> {
            text.encode_utf16().chain(std::iter::once(0)).collect()
        }

        /// A throw-away top-level window of the built-in STATIC class (no process, no message loop needed).
        pub fn window(title: &str, style: u32, rect: Rect) -> isize {
            let class = utf16("STATIC");
            let name = utf16(title);
            // SAFETY: valid NUL-terminated strings; the caller destroys the window.
            unsafe { CreateWindowExW(0, class.as_ptr(), name.as_ptr(), style, rect.x, rect.y, rect.w, rect.h, 0, 0, 0, std::ptr::null()) }
        }

        pub fn destroy(hwnd: isize) {
            // SAFETY: hwnd was created by `window`.
            unsafe { DestroyWindow(hwnd) };
        }

        pub fn parent_of(hwnd: isize) -> isize {
            // SAFETY: plain Win32 call.
            unsafe { GetParent(hwnd) }
        }

        pub fn style_of(hwnd: isize) -> u32 {
            // SAFETY: plain Win32 call.
            unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) as u32 }
        }

        pub fn visible(hwnd: isize) -> bool {
            // SAFETY: plain Win32 call.
            unsafe { IsWindowVisible(hwnd) != 0 }
        }

        /// Position and size of `hwnd` in the client coordinates of `parent`.
        pub fn client_rect_in(hwnd: isize, parent: isize) -> Rect {
            let mut rc = Rc::default();
            let mut origin = Pt::default();
            // SAFETY: valid out-pointers.
            unsafe {
                GetWindowRect(hwnd, &mut rc);
                ClientToScreen(parent, &mut origin);
            }
            Rect { x: rc.left - origin.x, y: rc.top - origin.y, w: rc.right - rc.left, h: rc.bottom - rc.top }
        }

        pub fn rect_of(hwnd: isize) -> Rect {
            let mut rc = Rc::default();
            // SAFETY: valid out-pointer.
            unsafe { GetWindowRect(hwnd, &mut rc) };
            Rect { x: rc.left, y: rc.top, w: rc.right - rc.left, h: rc.bottom - rc.top }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    // ----- pure rules -----

    #[test]
    fn embedded_style_is_a_clean_child_without_caption_or_frame() {
        let original = WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_VISIBLE;
        let style = embedded_style(original);
        assert_ne!(style & WS_CHILD, 0);
        assert_ne!(style & WS_VISIBLE, 0);
        for gone in [WS_POPUP, WS_CAPTION, WS_SYSMENU, WS_THICKFRAME, WS_MINIMIZEBOX, WS_MAXIMIZEBOX] {
            assert_eq!(style & gone, 0, "{gone:#x} should be stripped");
        }
        // Unrelated bits survive.
        assert_eq!(embedded_style(0x0000_0004) & 0x4, 0x4);
    }

    #[test]
    fn embedded_ex_style_drops_the_frame_and_taskbar_bits_only() {
        let ex = WS_EX_APPWINDOW | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_DLGMODALFRAME | WS_EX_TOOLWINDOW | 0x0008_0000;
        assert_eq!(embedded_ex_style(ex), 0x0008_0000);
    }

    #[test]
    fn scale_rect_converts_css_to_physical_pixels_and_never_goes_negative() {
        assert_eq!(scale_rect(10.0, 20.5, 300.0, 200.0, 1.5), Rect { x: 15, y: 31, w: 450, h: 300 });
        assert_eq!(scale_rect(-5.0, -1.0, 0.0, -9.0, 1.0), Rect { x: 0, y: 0, w: 1, h: 1 });
        assert_eq!(scale_rect(1.0, 1.0, 100.0, 100.0, 0.0), Rect { x: 1, y: 1, w: 100, h: 100 }, "bad dpr falls back to 1");
        assert_eq!(scale_rect(f64::NAN, 0.0, f64::INFINITY, 5.0, 2.0).x, 0);
    }

    fn info(hwnd: isize, title: &str, exe: &str, visible: bool) -> WindowInfo {
        WindowInfo { hwnd, title: title.into(), exe: exe.into(), visible }
    }

    #[test]
    fn pick_window_wants_the_exact_title_from_a_bluestacks_player() {
        let windows = vec![
            info(1, "wa-pod2", r"C:\Windows\explorer.exe", true),
            info(2, "wa-pod2 - notes", r"C:\Program Files\BlueStacks_nxt\HD-Player.exe", true),
            info(3, "WA-POD2", r"C:\Program Files\BlueStacks_nxt\HD-Player.exe", false),
            info(4, "wa-pod2", r"C:\Program Files\BlueStacks_nxt\HD-Player.exe", true),
        ];
        assert_eq!(pick_window(&windows, "wa-pod2", Some("hd-player")), Some(4), "visible exact match wins");
        assert_eq!(pick_window(&windows[..3], "wa-pod2", Some("hd-player")), Some(3), "hidden is still better than nothing");
        assert_eq!(pick_window(&windows, "wa-pod9", Some("hd-player")), None);
        assert_eq!(pick_window(&windows, "wa-pod2", None), Some(1), "without a process filter the first visible exact title wins");
    }

    #[test]
    fn pod_window_title_matches_the_bluestacks_display_name() {
        assert_eq!(pod_window_title("pod2"), "wa-pod2");
    }

    // ----- bookkeeping against a fake Win32 -----

    #[derive(Default)]
    struct FakeWin {
        windows: RefCell<Vec<(String, isize)>>,
        calls: RefCell<Vec<String>>,
        closed: RefCell<Vec<isize>>,
    }

    impl FakeWin {
        fn with(windows: &[(&str, isize)]) -> FakeWin {
            FakeWin { windows: RefCell::new(windows.iter().map(|(t, h)| (t.to_string(), *h)).collect()), ..Default::default() }
        }
        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    impl WinApi for &FakeWin {
        fn find_window(&self, title: &str) -> Option<isize> {
            self.windows.borrow().iter().find(|(t, _)| t == title).map(|(_, h)| *h)
        }
        fn is_window(&self, hwnd: isize) -> bool {
            !self.closed.borrow().contains(&hwnd)
        }
        fn snapshot(&self, hwnd: isize) -> Result<Original, String> {
            Ok(Original { style: WS_POPUP | WS_CAPTION | 0x7, ex_style: WS_EX_APPWINDOW, rect: Rect { x: 100, y: 50, w: 800, h: 600 } }).inspect(|_| self.calls.borrow_mut().push(format!("snapshot:{hwnd}")))
        }
        fn embed(&self, hwnd: isize, parent: isize, style: u32, _ex: u32, rect: Rect) -> Result<(), String> {
            assert_ne!(style & WS_CHILD, 0);
            self.calls.borrow_mut().push(format!("embed:{hwnd}->{parent}@{},{} {}x{}", rect.x, rect.y, rect.w, rect.h));
            Ok(())
        }
        fn place(&self, hwnd: isize, rect: Rect) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("place:{hwnd}@{},{} {}x{}", rect.x, rect.y, rect.w, rect.h));
            Ok(())
        }
        fn set_visible(&self, hwnd: isize, visible: bool) {
            self.calls.borrow_mut().push(format!("{}:{hwnd}", if visible { "show" } else { "hide" }));
        }
        fn restore(&self, hwnd: isize, original: &Original) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("restore:{hwnd}@{},{} {}x{} style={:#x}", original.rect.x, original.rect.y, original.rect.w, original.rect.h, original.style));
            Ok(())
        }
        fn focus(&self, hwnd: isize) {
            self.calls.borrow_mut().push(format!("focus:{hwnd}"));
        }
    }

    const R: Rect = Rect { x: 10, y: 20, w: 300, h: 400 };

    #[test]
    fn attach_embeds_the_pod_window_under_the_app_window() {
        let win = FakeWin::with(&[("wa-pod2", 22)]);
        let embedder = Embedder::new(&win, 999);
        embedder.attach("pod2", R).unwrap();
        assert_eq!(win.calls(), vec!["snapshot:22", "embed:22->999@10,20 300x400"]);
        assert_eq!(embedder.state().attached, vec!["pod2"]);
    }

    #[test]
    fn attaching_twice_only_moves_the_window_and_keeps_the_original_look() {
        let win = FakeWin::with(&[("wa-pod2", 22)]);
        let embedder = Embedder::new(&win, 999);
        embedder.attach("pod2", R).unwrap();
        embedder.attach("pod2", Rect { x: 0, y: 0, w: 50, h: 60 }).unwrap();
        assert_eq!(win.calls().iter().filter(|c| c.starts_with("snapshot")).count(), 1);
        assert_eq!(win.calls().last().unwrap(), "place:22@0,0 50x60");
        embedder.detach("pod2").unwrap();
        assert!(win.calls().iter().any(|c| c.contains("restore:22@100,50 800x600")), "restores the first snapshot");
    }

    #[test]
    fn attach_fails_with_a_clear_message_when_the_pod_has_no_window() {
        let win = FakeWin::with(&[]);
        let err = Embedder::new(&win, 999).attach("pod2", R).unwrap_err();
        assert!(err.contains("pod2") && err.contains("encendido"));
    }

    #[test]
    fn activate_shows_only_the_selected_tab() {
        let win = FakeWin::with(&[("wa-pod1", 11), ("wa-pod2", 22), ("wa-pod3", 33)]);
        let embedder = Embedder::new(&win, 999);
        for pod in ["pod1", "pod2", "pod3"] {
            embedder.attach(pod, R).unwrap();
        }
        win.calls.borrow_mut().clear();
        embedder.activate(Some("pod2"));
        assert_eq!(win.calls(), vec!["hide:11", "show:22", "hide:33"]);
        assert_eq!(embedder.state().active.as_deref(), Some("pod2"));

        win.calls.borrow_mut().clear();
        embedder.activate(None);
        assert_eq!(win.calls(), vec!["hide:11", "hide:22", "hide:33"]);
        assert_eq!(embedder.state().active, None);

        embedder.activate(Some("ghost"));
        assert_eq!(embedder.state().active, None, "unknown tabs are never active");
    }

    #[test]
    fn resize_requires_an_attached_pod() {
        let win = FakeWin::with(&[("wa-pod2", 22)]);
        let embedder = Embedder::new(&win, 999);
        assert!(embedder.resize("pod2", R).is_err());
        embedder.attach("pod2", R).unwrap();
        embedder.resize("pod2", Rect { x: 1, y: 2, w: 3, h: 4 }).unwrap();
        assert_eq!(win.calls().last().unwrap(), "place:22@1,2 3x4");
    }

    #[test]
    fn detach_restores_and_brings_the_window_to_the_front_then_forgets_it() {
        let win = FakeWin::with(&[("wa-pod2", 22)]);
        let embedder = Embedder::new(&win, 999);
        embedder.attach("pod2", R).unwrap();
        embedder.activate(Some("pod2"));
        win.calls.borrow_mut().clear();
        embedder.detach("pod2").unwrap();
        assert_eq!(win.calls(), vec![format!("restore:22@100,50 800x600 style={:#x}", WS_POPUP | WS_CAPTION | 0x7), "focus:22".to_string()]);
        assert_eq!(embedder.state(), EmbedState { attached: vec![], active: None });
        embedder.detach("pod2").unwrap(); // idempotent
    }

    #[test]
    fn a_window_the_user_closed_is_not_restored_and_can_be_embedded_again() {
        let win = FakeWin::with(&[("wa-pod2", 22)]);
        let embedder = Embedder::new(&win, 999);
        embedder.attach("pod2", R).unwrap();
        win.closed.borrow_mut().push(22);
        embedder.detach("pod2").unwrap();
        assert!(!win.calls().iter().any(|c| c.starts_with("restore")));

        // New BlueStacks window after a restart.
        embedder.attach("pod2", R).unwrap();
        *win.windows.borrow_mut() = vec![("wa-pod2".into(), 44)];
        win.closed.borrow_mut().push(22);
        embedder.attach("pod2", R).unwrap();
        assert!(win.calls().iter().any(|c| c.starts_with("embed:44")));
    }

    #[test]
    fn detach_all_restores_every_window() {
        let win = FakeWin::with(&[("wa-pod1", 11), ("wa-pod2", 22)]);
        let embedder = Embedder::new(&win, 999);
        embedder.attach("pod1", R).unwrap();
        embedder.attach("pod2", R).unwrap();
        assert!(embedder.detach_all().is_empty());
        assert_eq!(win.calls().iter().filter(|c| c.starts_with("restore")).count(), 2);
        assert!(embedder.state().attached.is_empty());
    }

    // ----- real user32 with dummy windows (never a pod) -----

    /// BlueStacks is a Qt top-level window that rewrites any move/size in WM_WINDOWPOSCHANGING. Before the fix the
    /// embedded pod ended up far off screen (y = 15000+) and the stage stayed black.
    #[cfg(windows)]
    #[test]
    fn real_win32_placement_wins_over_a_window_that_fights_every_move() {
        use win::{RealWin, dummy};

        let ws_overlapped = 0x00CF_0000u32;
        let host = dummy::window("agentautox1-test-host2", ws_overlapped, Rect { x: 50, y: 50, w: 900, h: 700 });
        let pod = dummy::qt_like_window("wa-agentautox1-qt-like", Rect { x: 200, y: 120, w: 528, h: 912 });
        assert!(host != 0 && pod != 0);

        let embedder = Embedder::new(RealWin { exe_filter: None }, host);
        let wanted = Rect { x: 40, y: 60, w: 600, h: 500 };
        embedder.attach("agentautox1-qt-like", wanted).unwrap();
        let at = |hwnd| dummy::client_rect_in(hwnd, host);
        assert_eq!(at(pod), wanted, "attach placed it where the UI asked");

        let moved = Rect { x: 10, y: 20, w: 640, h: 480 };
        embedder.resize("agentautox1-qt-like", moved).unwrap();
        assert_eq!(at(pod), moved, "resize too");
        embedder.resize("agentautox1-qt-like", moved).unwrap();
        assert_eq!(at(pod), moved, "and repeating it does not drift");

        embedder.detach_all();
        for hwnd in [pod, host] {
            dummy::destroy(hwnd);
        }
    }

    #[cfg(windows)]
    #[test]
    fn real_win32_embeds_and_restores_a_dummy_window() {
        use win::{RealWin, dummy};

        let ws_overlapped = 0x00CF_0000u32; // WS_OVERLAPPEDWINDOW
        let host = dummy::window("agentautox1-test-host", ws_overlapped, Rect { x: 50, y: 50, w: 900, h: 700 });
        let pod = dummy::window("wa-agentautox1-test-pod", ws_overlapped, Rect { x: 200, y: 120, w: 400, h: 300 });
        let other = dummy::window("wa-agentautox1-test-other", ws_overlapped, Rect { x: 300, y: 220, w: 400, h: 300 });
        assert!(host != 0 && pod != 0 && other != 0, "could not create the dummy windows");

        let embedder = Embedder::new(RealWin { exe_filter: None }, host);
        embedder.attach("agentautox1-test-pod", Rect { x: 10, y: 30, w: 320, h: 240 }).unwrap();
        embedder.attach("agentautox1-test-other", Rect { x: 10, y: 30, w: 320, h: 240 }).unwrap();

        assert_eq!(dummy::parent_of(pod), host, "embedded under the host window");
        let style = dummy::style_of(pod);
        assert_ne!(style & WS_CHILD, 0);
        assert_eq!(style & WS_CAPTION, 0, "no caption");
        assert_eq!((dummy::rect_of(pod).w, dummy::rect_of(pod).h), (320, 240), "sized to the placeholder");

        embedder.activate(Some("agentautox1-test-pod"));
        assert!(dummy::visible(pod) || !dummy::visible(host), "visible once its parent is visible");
        embedder.activate(None);
        assert!(!dummy::visible(pod) && !dummy::visible(other), "tabs hidden");

        assert!(embedder.detach_all().is_empty());
        assert_eq!(dummy::parent_of(pod), 0, "top level again");
        let restored = dummy::style_of(pod);
        assert_eq!(restored & WS_CHILD, 0);
        assert_ne!(restored & WS_CAPTION, 0, "caption is back");
        let r = dummy::rect_of(pod);
        assert_eq!((r.x, r.y, r.w, r.h), (200, 120, 400, 300), "original position and size");

        for hwnd in [pod, other, host] {
            dummy::destroy(hwnd);
        }
    }
}
