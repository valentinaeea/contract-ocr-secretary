"""Deny network system calls for this process before loading OCR libraries."""
import ctypes,ctypes.util,errno,socket
lib=ctypes.CDLL(ctypes.util.find_library('seccomp'),use_errno=True)
lib.seccomp_init.argtypes=[ctypes.c_uint32];lib.seccomp_init.restype=ctypes.c_void_p
lib.seccomp_syscall_resolve_name.argtypes=[ctypes.c_char_p];lib.seccomp_syscall_resolve_name.restype=ctypes.c_int
lib.seccomp_rule_add.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_int,ctypes.c_uint];lib.seccomp_rule_add.restype=ctypes.c_int
lib.seccomp_load.argtypes=[ctypes.c_void_p];lib.seccomp_load.restype=ctypes.c_int
lib.seccomp_release.argtypes=[ctypes.c_void_p]
ctx=lib.seccomp_init(0x7fff0000)
if not ctx:raise RuntimeError('Cannot initialize network guard')
for name in [b'socket',b'socketpair',b'connect',b'sendto',b'sendmsg',b'sendmmsg']:
 n=lib.seccomp_syscall_resolve_name(name)
 if n>=0 and lib.seccomp_rule_add(ctx,0x50000|errno.EPERM,n,0):raise RuntimeError('Cannot add network deny rule')
if lib.seccomp_load(ctx):raise RuntimeError('Cannot enforce network guard')
lib.seccomp_release(ctx)
try:
 socket.socket()
except PermissionError:
 NETWORK_BLOCKED=True
else:
 raise RuntimeError('Network guard test failed')
