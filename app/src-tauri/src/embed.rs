//! Embedded BlueStacks view (experimental, behind the `embedView` setting).
//!
//! A pod's BlueStacks window (HD-Player, title `wa-<pod>`) is shown "inside" the app without ever being re-parented:
//! it stays a normal top-level window (same style, same activation and input behaviour as when it is opened on its
//! own) but it is OWNED by the app window, so it always floats above it, minimises with it and has no taskbar button,
//! and it is moved to the screen rectangle of the placeholder the UI measured. Re-parenting it as a WS_CHILD of the
//! webview window was tried first: the toolbar worked but taps on the Android screen never arrived, because the
//! BlueStacks render/input window assumes its root is its own top-level window.
//!
//! The window keeps the aspect ratio it had before it was embedded (a portrait phone), fitted and centred inside the
//! placeholder, so it is tall and narrow instead of stretched to the full width.
//! Everything is restored (no owner, original position and size) when the tab is closed or the app exits.
//!
//! The rules (aspect fitting, window choice, bookkeeping) are pure and tested here against a fake `WinApi`;
//! `RealWin` is the user32 implementation and is exercised with dummy windows (never with a real pod in the tests).

use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// CSS pixels (what the UI measures) -> physical pixels (what Win32 wants), at least 1x1. The position may be
/// negative: a stage scrolled partly out of view starts above the top of the page.
pub fn scale_rect(x: f64, y: f64, width: f64, height: f64, dpr: f64) -> Rect {
    let dpr = if dpr.is_finite() && dpr > 0.0 { dpr } else { 1.0 };
    let px = |v: f64| if v.is_finite() { (v * dpr).round() as i32 } else { 0 };
    Rect { x: px(x), y: px(y), w: px(width).max(1), h: px(height).max(1) }
}

/// The overlap of two rectangles, `None` when they do not share a single pixel.
pub fn intersect(a: Rect, b: Rect) -> Option<Rect> {
    let left = a.x.max(b.x);
    let top = a.y.max(b.y);
    let right = (a.x + a.w).min(b.x + b.w);
    let bottom = (a.y + a.h).min(b.y + b.h);
    (right > left && bottom > top).then_some(Rect { x: left, y: top, w: right - left, h: bottom - top })
}

/// `inner` expressed relative to the top-left corner of `outer` (the coordinates SetWindowRgn wants).
pub fn relative_to(inner: Rect, outer: Rect) -> Rect {
    Rect { x: inner.x - outer.x, y: inner.y - outer.y, w: inner.w, h: inner.h }
}

/// Width / height of a typical BlueStacks portrait window (528x912 outer), used when the real one cannot be measured.
pub const DEFAULT_ASPECT: f64 = 0.58;
/// Where a window with an unusable remembered position (minimised, off screen) is put back.
pub const FALLBACK_NATIVE: Rect = Rect { x: 100, y: 100, w: 528, h: 912 };

fn rect_is_usable(rect: Rect) -> bool {
    rect.w >= 200 && rect.h >= 200 && rect.x > -10_000 && rect.y > -10_000 && rect.x < 30_000 && rect.y < 30_000
}

/// Aspect ratio (width / height) of the native window's OUTER rectangle, title bar and side toolbar included. A
/// minimised, off-screen or absurdly shaped window cannot be trusted: the portrait default is used instead.
pub fn native_aspect(rect: Rect) -> f64 {
    if !rect_is_usable(rect) {
        return DEFAULT_ASPECT;
    }
    let ratio = f64::from(rect.w) / f64::from(rect.h);
    if (0.25..=4.0).contains(&ratio) { ratio } else { DEFAULT_ASPECT }
}

/// The rectangle to remember (and restore) for a window: itself when usable, otherwise a sane place on screen.
pub fn restorable_rect(rect: Rect) -> Rect {
    if rect_is_usable(rect) { rect } else { FALLBACK_NATIVE }
}

/// Largest rectangle with the given aspect (width / height) that fits inside `container`, centred in it.
pub fn fit_aspect(container: Rect, aspect: f64) -> Rect {
    let aspect = if aspect.is_finite() && aspect > 0.0 { aspect } else { DEFAULT_ASPECT };
    let (cw, ch) = (container.w.max(1), container.h.max(1));
    let (w, h) = if f64::from(cw) / f64::from(ch) > aspect {
        (((f64::from(ch) * aspect).round() as i32).clamp(1, cw), ch) // limited by the height
    } else {
        (cw, ((f64::from(cw) / aspect).round() as i32).clamp(1, ch)) // limited by the width
    };
    Rect { x: container.x + (cw - w) / 2, y: container.y + (ch - h) / 2, w, h }
}

/// A rectangle in client coordinates -> screen coordinates, given where the client area starts on screen.
pub fn to_screen(origin: (i32, i32), rect: Rect) -> Rect {
    Rect { x: origin.0 + rect.x, y: origin.1 + rect.y, w: rect.w, h: rect.h }
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

/// What a window looked like before we embedded it: its outer rectangle on screen.
#[derive(Clone, Debug, PartialEq)]
pub struct Original {
    pub rect: Rect,
}

pub trait WinApi {
    fn find_window(&self, title: &str) -> Option<isize>;
    fn is_window(&self, hwnd: isize) -> bool;
    fn snapshot(&self, hwnd: isize) -> Result<Original, String>;
    /// Screen position of the top-left corner of `hwnd`'s client area.
    fn client_origin(&self, hwnd: isize) -> (i32, i32);
    /// Make `hwnd` owned by `owner`, put it at the SCREEN rectangle `rect`, above the owner, and show it.
    fn embed(&self, hwnd: isize, owner: isize, rect: Rect) -> Result<(), String>;
    /// Move/resize to the SCREEN rectangle `rect` without touching the z-order.
    fn place(&self, hwnd: isize, rect: Rect) -> Result<(), String>;
    fn set_visible(&self, hwnd: isize, visible: bool);
    /// Show only `visible` (relative to the window top-left corner) of the window; `None` shows all of it.
    fn set_clip(&self, hwnd: isize, visible: Option<Rect>);
    /// Back to an ownerless window at its original position and size.
    fn restore(&self, hwnd: isize, original: &Original) -> Result<(), String>;
    fn focus(&self, hwnd: isize);
}

struct Attached {
    hwnd: isize,
    original: Original,
    /// Aspect ratio of the native window, kept for every later placement.
    aspect: f64,
    /// Last box the UI measured, in client coordinates of the app window (physical pixels).
    container: Rect,
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
    /// Visible part of the webview (client coordinates, physical pixels). Whatever of a pod falls outside it is
    /// clipped away, so a scrolled page never lets the native window draw over the title bar or other cards.
    viewport: Mutex<Option<Rect>>,
}

impl<A: WinApi> Embedder<A> {
    pub fn new(api: A, parent: isize) -> Embedder<A> {
        Embedder { api, parent, attached: Mutex::new(BTreeMap::new()), active: Mutex::new(None), viewport: Mutex::new(None) }
    }

    pub fn set_viewport(&self, viewport: Rect) {
        *self.viewport.lock().unwrap() = Some(viewport);
    }

    /// The pod fixed rectangle inside its stage, whatever part of it is currently scrolled out of view.
    fn pod_rect(entry: &Attached) -> Rect {
        fit_aspect(entry.container, entry.aspect)
    }

    /// The part of the pod inside the viewport (client coordinates); the whole pod when no viewport is known.
    fn visible_part(&self, entry: &Attached) -> Option<Rect> {
        let pod = Self::pod_rect(entry);
        match *self.viewport.lock().unwrap() {
            Some(viewport) => intersect(pod, viewport),
            None => Some(pod),
        }
    }

    /// Clips the native window to the viewport. Qt re-applies its own geometry whenever it is shown or moved, so this
    /// runs after every placement; a pod that is completely out of view is hidden.
    fn clip(&self, entry: &Attached) {
        if self.viewport.lock().unwrap().is_none() {
            return;
        }
        let pod = Self::pod_rect(entry);
        match self.visible_part(entry) {
            None => self.api.set_visible(entry.hwnd, false),
            Some(part) if part == pod => self.api.set_clip(entry.hwnd, None),
            Some(part) => self.api.set_clip(entry.hwnd, Some(relative_to(part, pod))),
        }
    }

    /// Shows/hides (as the tab and the scroll position require), places and clips one pod.
    fn layout(&self, entry: &Attached, visible: bool) -> Result<(), String> {
        if self.visible_part(entry).is_none() {
            self.api.set_visible(entry.hwnd, false);
            return Ok(());
        }
        if visible {
            self.api.set_visible(entry.hwnd, true);
        }
        // Clip BEFORE placing: SetWindowRgn makes Windows send WM_WINDOWPOSCHANGING, which Qt answers with its own
        // geometry. The placement that follows (without that message) is the one that sticks.
        self.clip(entry);
        self.api.place(entry.hwnd, self.screen_rect(entry))
    }

    fn is_active(&self, pod: &str) -> bool {
        self.active.lock().unwrap().as_deref() == Some(pod)
    }

    pub fn state(&self) -> EmbedState {
        EmbedState { attached: self.attached.lock().unwrap().keys().cloned().collect(), active: self.active.lock().unwrap().clone() }
    }

    /// Where the window goes on screen: the native aspect fitted and centred in the measured box.
    fn screen_rect(&self, entry: &Attached) -> Rect {
        to_screen(self.api.client_origin(self.parent), Self::pod_rect(entry))
    }

    /// Embeds the pod's window inside `container` (client coordinates, physical pixels), or just re-places it when it
    /// is already embedded. The first call remembers the original look so `detach` can give it back.
    pub fn attach(&self, pod: &str, container: Rect) -> Result<(), String> {
        let mut attached = self.attached.lock().unwrap();
        if let Some(existing) = attached.get_mut(pod) {
            if self.api.is_window(existing.hwnd) {
                existing.container = container;
                return self.layout(existing, self.is_active(pod));
            }
            attached.remove(pod); // the window was closed: embed the new one
        }
        let hwnd = self
            .api
            .find_window(&pod_window_title(pod))
            .ok_or_else(|| format!("No encuentro la ventana de BlueStacks del pod «{pod}». ¿Está encendido?"))?;
        let measured = self.api.snapshot(hwnd)?;
        let entry = Attached {
            hwnd,
            aspect: native_aspect(measured.rect),
            original: Original { rect: restorable_rect(measured.rect) },
            container,
        };
        self.api.embed(hwnd, self.parent, self.screen_rect(&entry))?;
        if self.viewport.lock().unwrap().is_some() {
            self.clip(&entry);
            self.api.place(hwnd, self.screen_rect(&entry))?;
        }
        attached.insert(pod.to_string(), entry);
        Ok(())
    }

    pub fn resize(&self, pod: &str, container: Rect) -> Result<(), String> {
        let mut attached = self.attached.lock().unwrap();
        let entry = attached.get_mut(pod).ok_or_else(|| format!("El pod «{pod}» no está en la vista embebida."))?;
        entry.container = container;
        self.layout(entry, self.is_active(pod))
    }

    /// The app window moved: an owned window does not travel with its owner, so the visible pod is placed again.
    pub fn follow(&self) {
        let attached = self.attached.lock().unwrap();
        let active = self.active.lock().unwrap();
        if let Some(entry) = active.as_deref().and_then(|name| attached.get(name)) {
            let _ = self.layout(entry, true);
        }
    }

    /// Shows `pod` (if any) and hides every other embedded window. `None` hides them all.
    pub fn activate(&self, pod: Option<&str>) {
        let attached = self.attached.lock().unwrap();
        for (name, entry) in attached.iter() {
            if pod == Some(name.as_str()) {
                // Showing a Qt window lets it re-apply its own geometry: place and clip it again right after.
                let _ = self.layout(entry, true);
            } else {
                self.api.set_visible(entry.hwnd, false);
            }
        }
        *self.active.lock().unwrap() = pod.filter(|p| attached.contains_key(*p)).map(str::to_string);
    }

    /// Gives the window back (no owner, original place and size) and forgets it.
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

    const GWLP_HWNDPARENT: i32 = -8; // for a top-level window this is its OWNER
    const SW_HIDE: i32 = 0;
    const SW_SHOWNA: i32 = 8;
    const SW_RESTORE: i32 = 9;
    const SWP_NOZORDER: u32 = 0x0004;
    /// Skip WM_WINDOWPOSCHANGING: BlueStacks (Qt) uses it to force its own geometry back, which sent the re-parented
    /// window thousands of pixels off screen. Without the message our rectangle is applied as asked.
    const SWP_NOSENDCHANGING: u32 = 0x0400;
    /// Above the other top-level windows (and so above its owner).
    const HWND_TOP: isize = 0;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    #[repr(C)]
    #[derive(Default)]
    pub(super) struct Rc {
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

    type EnumProc = unsafe extern "system" fn(isize, isize) -> i32;

    #[link(name = "gdi32")]
    unsafe extern "system" {
        fn CreateRectRgn(left: i32, top: i32, right: i32, bottom: i32) -> isize;
        fn DeleteObject(object: isize) -> i32;
    }

    unsafe extern "system" {
        fn EnumWindows(proc: EnumProc, lparam: isize) -> i32;
        fn GetWindowTextW(hwnd: isize, text: *mut u16, max: i32) -> i32;
        fn IsWindowVisible(hwnd: isize) -> i32;
        fn IsWindow(hwnd: isize) -> i32;
        fn IsIconic(hwnd: isize) -> i32;
        fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
        fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
        fn ClientToScreen(hwnd: isize, point: *mut Pt) -> i32;
        fn GetWindowRect(hwnd: isize, rect: *mut Rc) -> i32;
        fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
        fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
        fn SetForegroundWindow(hwnd: isize) -> i32;
        fn SetWindowRgn(hwnd: isize, region: isize, redraw: i32) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn CloseHandle(handle: isize) -> i32;
        fn QueryFullProcessImageNameW(process: isize, flags: u32, name: *mut u16, size: *mut u32) -> i32;
    }

    #[cfg(test)]
    unsafe extern "system" {
        pub(super) fn CreateWindowExW(ex: u32, class: *const u16, name: *const u16, style: u32, x: i32, y: i32, w: i32, h: i32, parent: isize, menu: isize, instance: isize, param: *const std::ffi::c_void) -> isize;
        pub(super) fn DestroyWindow(hwnd: isize) -> i32;
        pub(super) fn GetWindow(hwnd: isize, cmd: u32) -> isize;
        pub(super) fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
        pub(super) fn GetWindowRgnBox(hwnd: isize, rect: *mut Rc) -> i32;
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
            }
            Ok(Original { rect: Rect { x: rc.left, y: rc.top, w: rc.right - rc.left, h: rc.bottom - rc.top } })
        }

        fn client_origin(&self, hwnd: isize) -> (i32, i32) {
            let mut origin = Pt::default();
            // SAFETY: valid out-pointer.
            unsafe { ClientToScreen(hwnd, &mut origin) };
            (origin.x, origin.y)
        }

        fn embed(&self, hwnd: isize, owner: isize, rect: Rect) -> Result<(), String> {
            // SAFETY: plain Win32 window calls on handles we just looked up. The owner is the only thing that changes:
            // style, parent and activation stay exactly as BlueStacks made them.
            unsafe {
                if IsIconic(hwnd) != 0 {
                    ShowWindow(hwnd, SW_RESTORE);
                }
                SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, owner);
                // Show first and place after: showing a hidden Qt window runs its WM_WINDOWPOSCHANGING too.
                ShowWindow(hwnd, SW_SHOWNA);
                if SetWindowPos(hwnd, HWND_TOP, rect.x, rect.y, rect.w, rect.h, SWP_NOSENDCHANGING | SWP_NOACTIVATE) == 0 {
                    return Err(last_os_error("No se pudo colocar la ventana del pod en la app"));
                }
            }
            Ok(())
        }

        fn place(&self, hwnd: isize, rect: Rect) -> Result<(), String> {
            // SAFETY: plain Win32 call. The z-order is left alone: the owner relation keeps the window above the app.
            let ok = unsafe { SetWindowPos(hwnd, 0, rect.x, rect.y, rect.w, rect.h, SWP_NOZORDER | SWP_NOSENDCHANGING | SWP_NOACTIVATE) };
            if ok == 0 { Err(last_os_error("No se pudo mover la ventana del pod")) } else { Ok(()) }
        }

        fn set_visible(&self, hwnd: isize, visible: bool) {
            // SAFETY: plain Win32 call.
            unsafe { ShowWindow(hwnd, if visible { SW_SHOWNA } else { SW_HIDE }) };
        }

        fn set_clip(&self, hwnd: isize, visible: Option<Rect>) {
            // SAFETY: plain Win32 calls. After a successful SetWindowRgn the system owns the region handle.
            unsafe {
                match visible {
                    None => {
                        SetWindowRgn(hwnd, 0, 1);
                    }
                    Some(r) => {
                        let region = CreateRectRgn(r.x, r.y, r.x + r.w, r.y + r.h);
                        if region != 0 && SetWindowRgn(hwnd, region, 1) == 0 {
                            DeleteObject(region);
                        }
                    }
                }
            }
        }

        fn restore(&self, hwnd: isize, original: &Original) -> Result<(), String> {
            // SAFETY: plain Win32 window calls.
            unsafe {
                SetWindowRgn(hwnd, 0, 1); // the native window comes back whole
                SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, 0);
                ShowWindow(hwnd, SW_SHOWNA);
                let r = original.rect;
                SetWindowPos(hwnd, HWND_TOP, r.x, r.y, r.w, r.h, SWP_NOSENDCHANGING | SWP_NOACTIVATE);
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

        const GWL_STYLE: i32 = -16;
        const GW_OWNER: u32 = 4;

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

        /// The owner of a top-level window (0 when it has none).
        pub fn owner_of(hwnd: isize) -> isize {
            // SAFETY: plain Win32 call.
            unsafe { GetWindow(hwnd, GW_OWNER) }
        }

        pub fn style_of(hwnd: isize) -> u32 {
            // SAFETY: plain Win32 call.
            unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) as u32 }
        }

        pub fn visible(hwnd: isize) -> bool {
            // SAFETY: plain Win32 call.
            unsafe { IsWindowVisible(hwnd) != 0 }
        }

        /// Screen position of the client area of `hwnd`.
        pub fn client_origin(hwnd: isize) -> (i32, i32) {
            RealWin { exe_filter: None }.client_origin(hwnd)
        }

        /// Bounding box of the window region (relative to the window top-left), `None` when it has no region.
        pub fn region_box(hwnd: isize) -> Option<Rect> {
            let mut rc = Rc::default();
            // SAFETY: valid out-pointer.
            let kind = unsafe { GetWindowRgnBox(hwnd, &mut rc) };
            (kind != 0).then_some(Rect { x: rc.left, y: rc.top, w: rc.right - rc.left, h: rc.bottom - rc.top })
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
    fn scale_rect_converts_css_to_physical_pixels_and_keeps_the_size_positive() {
        assert_eq!(scale_rect(10.0, 20.5, 300.0, 200.0, 1.5), Rect { x: 15, y: 31, w: 450, h: 300 });
        assert_eq!(scale_rect(-5.0, -1.0, 0.0, -9.0, 1.0), Rect { x: -5, y: -1, w: 1, h: 1 }, "a scrolled stage starts above the page");
        assert_eq!(scale_rect(1.0, 1.0, 100.0, 100.0, 0.0), Rect { x: 1, y: 1, w: 100, h: 100 }, "bad dpr falls back to 1");
        assert_eq!(scale_rect(f64::NAN, 0.0, f64::INFINITY, 5.0, 2.0).x, 0);
    }

    #[test]
    fn native_aspect_is_the_outer_window_ratio_and_ignores_unusable_windows() {
        let portrait = Rect { x: 300, y: 100, w: 528, h: 912 };
        assert!((native_aspect(portrait) - 528.0 / 912.0).abs() < 1e-9);
        let minimised = Rect { x: -32000, y: -32000, w: 160, h: 28 };
        assert_eq!(native_aspect(minimised), DEFAULT_ASPECT);
        assert_eq!(native_aspect(Rect { x: 0, y: 0, w: 5000, h: 200 }), DEFAULT_ASPECT, "absurd shapes fall back");
        assert_eq!(native_aspect(Rect::default()), DEFAULT_ASPECT);
    }

    #[test]
    fn restorable_rect_keeps_a_good_place_and_replaces_a_lost_one() {
        let ok = Rect { x: -1500, y: 40, w: 600, h: 900 }; // a second monitor on the left is fine
        assert_eq!(restorable_rect(ok), ok);
        assert_eq!(restorable_rect(Rect { x: -32000, y: -32000, w: 160, h: 28 }), FALLBACK_NATIVE);
    }

    #[test]
    fn fit_aspect_makes_a_wide_box_tall_and_narrow_and_centres_it() {
        // The reported case: a ~1650x870 landscape box and a portrait phone (528x912).
        let aspect = 528.0 / 912.0;
        let fitted = fit_aspect(Rect { x: 300, y: 200, w: 1650, h: 870 }, aspect);
        assert_eq!(fitted.h, 870, "uses the whole height");
        assert_eq!(fitted.w, 504);
        assert_eq!(fitted.x, 300 + (1650 - 504) / 2, "centred horizontally");
        assert_eq!(fitted.y, 200);
        assert!((f64::from(fitted.w) / f64::from(fitted.h) - aspect).abs() < 0.002, "same aspect as the native window");
    }

    #[test]
    fn fit_aspect_is_limited_by_the_width_when_the_box_is_narrow() {
        let fitted = fit_aspect(Rect { x: 10, y: 20, w: 300, h: 900 }, 0.6);
        assert_eq!((fitted.w, fitted.h), (300, 500));
        assert_eq!((fitted.x, fitted.y), (10, 20 + 200), "centred vertically");
    }

    #[test]
    fn fit_aspect_survives_degenerate_input() {
        for container in [Rect::default(), Rect { x: 5, y: 5, w: 1, h: 1 }, Rect { x: 0, y: 0, w: 3, h: 2000 }] {
            for aspect in [0.0, -1.0, f64::NAN, f64::INFINITY, 0.58] {
                let r = fit_aspect(container, aspect);
                assert!(r.w >= 1 && r.h >= 1, "{container:?} {aspect}: {r:?}");
                assert!(r.w <= container.w.max(1) && r.h <= container.h.max(1), "never bigger than the box");
            }
        }
    }

    #[test]
    fn to_screen_offsets_by_the_client_origin() {
        assert_eq!(to_screen((100, -7), Rect { x: 5, y: 6, w: 7, h: 8 }), Rect { x: 105, y: -1, w: 7, h: 8 });
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

    /// Native window of every fake pod: portrait 400x800 (aspect 0.5) at (100, 50).
    const NATIVE: Rect = Rect { x: 100, y: 50, w: 400, h: 800 };
    /// Where the fake app window's client area starts on screen.
    const ORIGIN: (i32, i32) = (1000, 200);

    #[derive(Default)]
    struct FakeWin {
        windows: RefCell<Vec<(String, isize)>>,
        calls: RefCell<Vec<String>>,
        closed: RefCell<Vec<isize>>,
        native: RefCell<Option<Rect>>,
        origin: RefCell<Option<(i32, i32)>>,
    }

    impl FakeWin {
        fn with(windows: &[(&str, isize)]) -> FakeWin {
            FakeWin { windows: RefCell::new(windows.iter().map(|(t, h)| (t.to_string(), *h)).collect()), ..Default::default() }
        }
        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
        fn log(&self, what: String) {
            self.calls.borrow_mut().push(what);
        }
    }

    fn describe(rect: Rect) -> String {
        format!("{},{} {}x{}", rect.x, rect.y, rect.w, rect.h)
    }

    impl WinApi for &FakeWin {
        fn find_window(&self, title: &str) -> Option<isize> {
            self.windows.borrow().iter().find(|(t, _)| t == title).map(|(_, h)| *h)
        }
        fn is_window(&self, hwnd: isize) -> bool {
            !self.closed.borrow().contains(&hwnd)
        }
        fn snapshot(&self, hwnd: isize) -> Result<Original, String> {
            self.log(format!("snapshot:{hwnd}"));
            Ok(Original { rect: self.native.borrow().unwrap_or(NATIVE) })
        }
        fn client_origin(&self, _hwnd: isize) -> (i32, i32) {
            self.origin.borrow().unwrap_or(ORIGIN)
        }
        fn embed(&self, hwnd: isize, owner: isize, rect: Rect) -> Result<(), String> {
            self.log(format!("embed:{hwnd}->{owner}@{}", describe(rect)));
            Ok(())
        }
        fn place(&self, hwnd: isize, rect: Rect) -> Result<(), String> {
            self.log(format!("place:{hwnd}@{}", describe(rect)));
            Ok(())
        }
        fn set_visible(&self, hwnd: isize, visible: bool) {
            self.log(format!("{}:{hwnd}", if visible { "show" } else { "hide" }));
        }
        fn set_clip(&self, hwnd: isize, visible: Option<Rect>) {
            self.log(format!("clip:{hwnd}@{}", visible.map_or("none".to_string(), describe)));
        }
        fn restore(&self, hwnd: isize, original: &Original) -> Result<(), String> {
            self.log(format!("restore:{hwnd}@{}", describe(original.rect)));
            Ok(())
        }
        fn focus(&self, hwnd: isize) {
            self.log(format!("focus:{hwnd}"));
        }
    }

    /// A wide box like the one in the app: 1650x870 starting at (300, 20) in the client area.
    const WIDE: Rect = Rect { x: 300, y: 20, w: 1650, h: 870 };
    /// Native aspect 0.5 fitted in WIDE: 435x870, centred -> x = 300 + (1650-435)/2 = 907; on screen + ORIGIN.
    const WIDE_SCREEN: &str = "1907,220 435x870";

    #[test]
    fn attach_embeds_the_pod_window_with_its_native_aspect_not_the_full_box() {
        let win = FakeWin::with(&[("wa-pod2", 22)]);
        let embedder = Embedder::new(&win, 999);
        embedder.attach("pod2", WIDE).unwrap();
        assert_eq!(win.calls(), vec!["snapshot:22".to_string(), format!("embed:22->999@{WIDE_SCREEN}")]);
        assert_eq!(embedder.state().attached, vec!["pod2"]);
    }

    #[test]
    fn the_window_never_leaves_its_native_aspect_when_the_box_changes() {
        let win = FakeWin::with(&[("wa-pod2", 22)]);
        let embedder = Embedder::new(&win, 999);
        embedder.attach("pod2", WIDE).unwrap();
        // The app window was shrunk: a short box. Height-limited again, still 1:2.
        embedder.resize("pod2", Rect { x: 300, y: 20, w: 1000, h: 500 }).unwrap();
        assert_eq!(win.calls().last().unwrap(), "place:22@1675,220 250x500");
        // A narrow box: width-limited.
        embedder.resize("pod2", Rect { x: 0, y: 0, w: 200, h: 900 }).unwrap();
        assert_eq!(win.calls().last().unwrap(), "place:22@1000,450 200x400");
    }

    #[test]
    fn attaching_twice_only_moves_the_window_and_keeps_the_original_look() {
        let win = FakeWin::with(&[("wa-pod2", 22)]);
        let embedder = Embedder::new(&win, 999);
        embedder.attach("pod2", WIDE).unwrap();
        *win.native.borrow_mut() = Some(Rect { x: 0, y: 0, w: 900, h: 300 }); // would change the aspect if re-measured
        embedder.attach("pod2", Rect { x: 0, y: 0, w: 100, h: 400 }).unwrap();
        assert_eq!(win.calls().iter().filter(|c| c.starts_with("snapshot")).count(), 1);
        assert_eq!(win.calls().last().unwrap(), "place:22@1000,300 100x200");
        embedder.detach("pod2").unwrap();
        assert!(win.calls().iter().any(|c| c == "restore:22@100,50 400x800"), "restores the first snapshot");
    }

    #[test]
    fn an_unmeasurable_window_gets_the_portrait_default_and_a_sane_restore_place() {
        let win = FakeWin::with(&[("wa-pod2", 22)]);
        *win.native.borrow_mut() = Some(Rect { x: -32000, y: -32000, w: 160, h: 28 }); // minimised
        let embedder = Embedder::new(&win, 999);
        embedder.attach("pod2", Rect { x: 0, y: 0, w: 1000, h: 1000 }).unwrap();
        assert_eq!(win.calls().last().unwrap(), "embed:22->999@1210,200 580x1000");
        embedder.detach("pod2").unwrap();
        assert!(win.calls().iter().any(|c| c == "restore:22@100,100 528x912"));
    }

    #[test]
    fn attach_fails_with_a_clear_message_when_the_pod_has_no_window() {
        let win = FakeWin::with(&[]);
        let err = Embedder::new(&win, 999).attach("pod2", WIDE).unwrap_err();
        assert!(err.contains("pod2") && err.contains("encendido"));
    }

    #[test]
    fn activate_shows_only_the_selected_tab() {
        let win = FakeWin::with(&[("wa-pod1", 11), ("wa-pod2", 22), ("wa-pod3", 33)]);
        let embedder = Embedder::new(&win, 999);
        for pod in ["pod1", "pod2", "pod3"] {
            embedder.attach(pod, WIDE).unwrap();
        }
        win.calls.borrow_mut().clear();
        embedder.activate(Some("pod2"));
        assert_eq!(win.calls(), vec!["hide:11".to_string(), "show:22".to_string(), format!("place:22@{WIDE_SCREEN}"), "hide:33".to_string()]);
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
        assert!(embedder.resize("pod2", WIDE).is_err());
        embedder.attach("pod2", WIDE).unwrap();
        embedder.resize("pod2", WIDE).unwrap();
        assert_eq!(win.calls().last().unwrap(), &format!("place:22@{WIDE_SCREEN}"));
    }

    #[test]
    fn follow_replaces_only_the_visible_pod_after_the_app_window_moves() {
        let win = FakeWin::with(&[("wa-pod1", 11), ("wa-pod2", 22)]);
        let embedder = Embedder::new(&win, 999);
        embedder.attach("pod1", WIDE).unwrap();
        embedder.attach("pod2", WIDE).unwrap();
        embedder.activate(Some("pod2"));

        win.calls.borrow_mut().clear();
        embedder.follow(); // nothing moved yet: same place
        assert_eq!(win.calls(), vec!["show:22".to_string(), format!("place:22@{WIDE_SCREEN}")]);

        *win.origin.borrow_mut() = Some((0, 0)); // the app window was dragged to the top-left corner
        win.calls.borrow_mut().clear();
        embedder.follow();
        assert_eq!(win.calls(), vec!["show:22", "place:22@907,20 435x870"]);

        embedder.activate(None);
        win.calls.borrow_mut().clear();
        embedder.follow();
        assert!(win.calls().is_empty(), "nothing visible, nothing to move");
    }

    #[test]
    fn detach_restores_and_brings_the_window_to_the_front_then_forgets_it() {
        let win = FakeWin::with(&[("wa-pod2", 22)]);
        let embedder = Embedder::new(&win, 999);
        embedder.attach("pod2", WIDE).unwrap();
        embedder.activate(Some("pod2"));
        win.calls.borrow_mut().clear();
        embedder.detach("pod2").unwrap();
        assert_eq!(win.calls(), vec!["restore:22@100,50 400x800", "focus:22"]);
        assert_eq!(embedder.state(), EmbedState { attached: vec![], active: None });
        embedder.detach("pod2").unwrap(); // idempotent
    }

    #[test]
    fn a_window_the_user_closed_is_not_restored_and_can_be_embedded_again() {
        let win = FakeWin::with(&[("wa-pod2", 22)]);
        let embedder = Embedder::new(&win, 999);
        embedder.attach("pod2", WIDE).unwrap();
        win.closed.borrow_mut().push(22);
        embedder.detach("pod2").unwrap();
        assert!(!win.calls().iter().any(|c| c.starts_with("restore")));

        // New BlueStacks window after a restart.
        embedder.attach("pod2", WIDE).unwrap();
        *win.windows.borrow_mut() = vec![("wa-pod2".into(), 44)];
        win.closed.borrow_mut().push(22);
        embedder.attach("pod2", WIDE).unwrap();
        assert!(win.calls().iter().any(|c| c.starts_with("embed:44")));
    }

    #[test]
    fn detach_all_restores_every_window() {
        let win = FakeWin::with(&[("wa-pod1", 11), ("wa-pod2", 22)]);
        let embedder = Embedder::new(&win, 999);
        embedder.attach("pod1", WIDE).unwrap();
        embedder.attach("pod2", WIDE).unwrap();
        assert!(embedder.detach_all().is_empty());
        assert_eq!(win.calls().iter().filter(|c| c.starts_with("restore")).count(), 2);
        assert!(embedder.state().attached.is_empty());
    }

    // ----- scrolling: fixed size, clipped to the viewport -----

    const PAGE: Rect = Rect { x: 0, y: 0, w: 2000, h: 889 };

    /// A stage that starts `top` pixels from the top of the page (negative when scrolled up past it).
    fn stage_at(top: i32) -> Rect {
        Rect { x: 300, y: top, w: 1650, h: 870 }
    }

    #[test]
    fn clip_math_intersects_and_translates_rectangles() {
        let a = Rect { x: 0, y: 0, w: 100, h: 100 };
        assert_eq!(intersect(a, Rect { x: 50, y: -20, w: 100, h: 60 }), Some(Rect { x: 50, y: 0, w: 50, h: 40 }));
        assert_eq!(intersect(a, Rect { x: 100, y: 0, w: 10, h: 10 }), None, "touching edges share no pixel");
        assert_eq!(intersect(a, Rect { x: -50, y: -50, w: 10, h: 10 }), None);
        assert_eq!(relative_to(Rect { x: 50, y: 10, w: 5, h: 6 }, Rect { x: 40, y: 4, w: 99, h: 99 }), Rect { x: 10, y: 6, w: 5, h: 6 });
    }

    #[test]
    fn scrolling_keeps_the_pod_size_and_clips_the_part_outside_the_viewport() {
        let win = FakeWin::with(&[("wa-pod2", 22)]);
        let embedder = Embedder::new(&win, 999);
        embedder.set_viewport(PAGE);
        embedder.attach("pod2", stage_at(20)).unwrap();
        embedder.activate(Some("pod2"));

        // Stage bottom (20 + 870) is one pixel below the viewport: 1 row clipped, size is the full 435x870.
        win.calls.borrow_mut().clear();
        embedder.resize("pod2", stage_at(20)).unwrap();
        assert_eq!(win.calls(), vec!["show:22", "clip:22@0,0 435x869", "place:22@1907,220 435x870"]);

        // Scrolled 300 px down: the pod moves up with the stage, same size, its top 300 px are hidden.
        win.calls.borrow_mut().clear();
        embedder.resize("pod2", stage_at(-300)).unwrap();
        assert_eq!(win.calls(), vec!["show:22", "clip:22@0,300 435x570", "place:22@1907,-100 435x870"]);

        // Scrolled back so it is whole again: no clip at all.
        embedder.set_viewport(Rect { h: 1200, ..PAGE });
        win.calls.borrow_mut().clear();
        embedder.resize("pod2", stage_at(20)).unwrap();
        assert_eq!(win.calls(), vec!["show:22", "clip:22@none", "place:22@1907,220 435x870"]);
    }

    #[test]
    fn a_pod_scrolled_completely_out_of_view_is_hidden_and_comes_back() {
        let win = FakeWin::with(&[("wa-pod2", 22)]);
        let embedder = Embedder::new(&win, 999);
        embedder.set_viewport(PAGE);
        embedder.attach("pod2", stage_at(20)).unwrap();
        embedder.activate(Some("pod2"));

        win.calls.borrow_mut().clear();
        embedder.resize("pod2", stage_at(-900)).unwrap();
        assert_eq!(win.calls(), vec!["hide:22"], "nothing to draw, nothing placed");

        win.calls.borrow_mut().clear();
        embedder.resize("pod2", stage_at(-100)).unwrap();
        assert_eq!(win.calls(), vec!["show:22", "clip:22@0,100 435x770", "place:22@1907,100 435x870"]);
    }

    #[test]
    fn a_tab_that_is_not_active_is_never_shown_by_scrolling() {
        let win = FakeWin::with(&[("wa-pod1", 11), ("wa-pod2", 22)]);
        let embedder = Embedder::new(&win, 999);
        embedder.set_viewport(PAGE);
        embedder.attach("pod1", stage_at(20)).unwrap();
        embedder.attach("pod2", stage_at(20)).unwrap();
        embedder.activate(Some("pod2"));
        win.calls.borrow_mut().clear();
        embedder.resize("pod1", stage_at(-100)).unwrap();
        assert!(!win.calls().iter().any(|c| c.starts_with("show")), "{:?}", win.calls());
    }

    #[test]
    fn follow_clips_too_after_the_app_window_moves() {
        let win = FakeWin::with(&[("wa-pod2", 22)]);
        let embedder = Embedder::new(&win, 999);
        embedder.set_viewport(PAGE);
        embedder.attach("pod2", stage_at(-300)).unwrap();
        embedder.activate(Some("pod2"));
        win.calls.borrow_mut().clear();
        embedder.follow();
        assert_eq!(win.calls(), vec!["show:22", "clip:22@0,300 435x570", "place:22@1907,-100 435x870"]);
    }

    // ----- real user32 with dummy windows (never a pod) -----

    const WS_OVERLAPPEDWINDOW: u32 = 0x00CF_0000;
    const WS_CAPTION: u32 = 0x00C0_0000;
    const WS_CHILD: u32 = 0x4000_0000;
    const WS_VISIBLE: u32 = 0x1000_0000;

    /// BlueStacks is a Qt top-level window that rewrites any move/size in WM_WINDOWPOSCHANGING. Before the fix the
    /// embedded pod ended up far off screen (y = 15000+) and the stage stayed black.
    #[cfg(windows)]
    #[test]
    fn real_win32_placement_wins_over_a_window_that_fights_every_move() {
        use win::{RealWin, dummy};

        let host = dummy::window("agentautox1-test-host2", WS_OVERLAPPEDWINDOW, Rect { x: 50, y: 50, w: 900, h: 700 });
        let pod = dummy::qt_like_window("wa-agentautox1-qt-like", Rect { x: 200, y: 120, w: 528, h: 912 });
        assert!(host != 0 && pod != 0);

        let embedder = Embedder::new(RealWin { exe_filter: None }, host);
        let aspect = native_aspect(Rect { x: 200, y: 120, w: 528, h: 912 });
        let wanted_box = Rect { x: 40, y: 60, w: 600, h: 500 };
        let expected = |container: Rect| to_screen(dummy::client_origin(host), fit_aspect(container, aspect));

        embedder.attach("agentautox1-qt-like", wanted_box).unwrap();
        assert_eq!(dummy::rect_of(pod), expected(wanted_box), "attach placed it where the UI asked, with the native aspect");

        let moved = Rect { x: 10, y: 20, w: 640, h: 480 };
        embedder.resize("agentautox1-qt-like", moved).unwrap();
        assert_eq!(dummy::rect_of(pod), expected(moved), "resize too");
        embedder.resize("agentautox1-qt-like", moved).unwrap();
        assert_eq!(dummy::rect_of(pod), expected(moved), "and repeating it does not drift");

        embedder.detach_all();
        for hwnd in [pod, host] {
            dummy::destroy(hwnd);
        }
    }

    #[cfg(windows)]
    #[test]
    fn real_win32_clips_the_window_to_the_viewport_and_clears_the_clip_on_detach() {
        use win::{RealWin, dummy};

        let host = dummy::window("agentautox1-test-host3", WS_OVERLAPPEDWINDOW, Rect { x: 50, y: 50, w: 900, h: 700 });
        let pod = dummy::qt_like_window("wa-agentautox1-clip", Rect { x: 200, y: 120, w: 400, h: 800 });
        assert!(host != 0 && pod != 0);

        let embedder = Embedder::new(RealWin { exe_filter: None }, host);
        embedder.set_viewport(Rect { x: 0, y: 0, w: 1000, h: 600 });
        // 400x800 native (1:2) in a 300x600 box starting 100 px above the page: pod 300x600 at y = -100.
        embedder.attach("agentautox1-clip", Rect { x: 50, y: -100, w: 300, h: 600 }).unwrap();
        embedder.activate(Some("agentautox1-clip"));

        let r = dummy::rect_of(pod);
        assert_eq!((r.w, r.h), (300, 600), "full size even though 100 px are above the viewport");
        assert_eq!(dummy::client_origin(host).1 - 100, r.y, "moves with the stage");
        assert_eq!(dummy::region_box(pod), Some(Rect { x: 0, y: 100, w: 300, h: 500 }), "top 100 px clipped away");
        assert!(dummy::visible(pod));

        // Scrolled to where the whole pod is inside the viewport: the clip goes away, the size stays.
        embedder.resize("agentautox1-clip", Rect { x: 50, y: 0, w: 300, h: 600 }).unwrap();
        assert_eq!(dummy::region_box(pod), None);
        assert_eq!((dummy::rect_of(pod).w, dummy::rect_of(pod).h), (300, 600));

        // Clip again, then hand the window back: no region left.
        embedder.resize("agentautox1-clip", Rect { x: 50, y: -100, w: 300, h: 600 }).unwrap();
        assert!(dummy::region_box(pod).is_some());
        embedder.detach_all();
        assert_eq!(dummy::region_box(pod), None, "native window intact after un-embedding");

        for hwnd in [pod, host] {
            dummy::destroy(hwnd);
        }
    }

    #[cfg(windows)]
    #[test]
    fn real_win32_embeds_as_an_owned_top_level_window_and_restores_it() {
        use win::{RealWin, dummy};

        let host = dummy::window("agentautox1-test-host", WS_OVERLAPPEDWINDOW, Rect { x: 50, y: 50, w: 900, h: 700 });
        let pod = dummy::window("wa-agentautox1-test-pod", WS_OVERLAPPEDWINDOW, Rect { x: 200, y: 120, w: 400, h: 300 });
        let other = dummy::window("wa-agentautox1-test-other", WS_OVERLAPPEDWINDOW, Rect { x: 300, y: 220, w: 400, h: 300 });
        assert!(host != 0 && pod != 0 && other != 0, "could not create the dummy windows");
        let style_before = dummy::style_of(pod);

        let embedder = Embedder::new(RealWin { exe_filter: None }, host);
        let stage = Rect { x: 10, y: 30, w: 320, h: 240 };
        embedder.attach("agentautox1-test-pod", stage).unwrap();
        embedder.attach("agentautox1-test-other", stage).unwrap();

        assert_eq!(dummy::owner_of(pod), host, "owned by the host window");
        let style = dummy::style_of(pod);
        assert_eq!(style & !WS_VISIBLE, style_before & !WS_VISIBLE, "style untouched: still the native top-level window");
        assert_eq!(style & WS_CHILD, 0, "never a child window");
        assert_eq!((dummy::rect_of(pod).w, dummy::rect_of(pod).h), (320, 240), "native 4:3 fills a 4:3 stage");

        embedder.activate(Some("agentautox1-test-pod"));
        assert!(dummy::visible(pod), "the active tab is shown");
        assert!(!dummy::visible(other), "the other tab is hidden");
        embedder.activate(None);
        assert!(!dummy::visible(pod) && !dummy::visible(other), "tabs hidden");

        assert!(embedder.detach_all().is_empty());
        assert_eq!(dummy::owner_of(pod), 0, "no owner again");
        assert_ne!(dummy::style_of(pod) & WS_CAPTION, 0, "caption still there");
        let r = dummy::rect_of(pod);
        assert_eq!((r.x, r.y, r.w, r.h), (200, 120, 400, 300), "original position and size");

        for hwnd in [pod, other, host] {
            dummy::destroy(hwnd);
        }
    }
}
