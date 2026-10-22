//! EXPERIMENT. Raw ABI, no imports:
//! `ui_alloc(len) -> ptr`, `ui_handle(ptr, len) -> u64` (`out_ptr << 32 | out_len`),
//! `ui_free(ptr, len)`. Input and output are UTF-8 JSON (see `handle_json`).

use std::alloc::{alloc, dealloc, Layout};

#[no_mangle]
pub extern "C" fn ui_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::NonNull::dangling().as_ptr();
    }
    unsafe { alloc(Layout::from_size_align(len, 1).unwrap()) }
}

#[no_mangle]
pub unsafe extern "C" fn ui_free(ptr: *mut u8, len: usize) {
    if len != 0 {
        dealloc(ptr, Layout::from_size_align(len, 1).unwrap());
    }
}

#[no_mangle]
pub unsafe extern "C" fn ui_handle(ptr: *const u8, len: usize) -> u64 {
    let input = std::slice::from_raw_parts(ptr, len);
    let output = appport_ui_contract::handle_json(input).into_bytes().into_boxed_slice();
    let out_len = output.len();
    let out_ptr = Box::into_raw(output) as *mut u8;
    ((out_ptr as u64) << 32) | out_len as u64
}
