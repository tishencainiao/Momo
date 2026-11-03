# -*- coding: utf-8 -*-
"""Read dsh-pet API key from Windows Credential Manager via ctypes (no deps)."""
import ctypes
from ctypes import wintypes

CRED_TYPE_GENERIC = 1
ERROR_NOT_FOUND = 1168

class FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]

class CREDENTIALW(ctypes.Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("TargetName", wintypes.LPWSTR),
        ("Comment", wintypes.LPWSTR),
        ("LastWritten", FILETIME),
        ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
        ("Persist", wintypes.DWORD),
        ("AttributeCount", wintypes.DWORD),
        ("Attributes", ctypes.c_void_p),
        ("TargetAlias", wintypes.LPWSTR),
        ("UserName", wintypes.LPWSTR),
    ]

advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
advapi32.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                               ctypes.POINTER(ctypes.POINTER(CREDENTIALW))]
advapi32.CredReadW.restype = wintypes.BOOL
advapi32.CredFree.argtypes = [ctypes.c_void_p]

def read_cred(target):
    cred = ctypes.POINTER(CREDENTIALW)()
    ok = advapi32.CredReadW(target, CRED_TYPE_GENERIC, 0, ctypes.byref(cred))
    if not ok:
        err = ctypes.get_last_error()
        return (err, None, None)
    try:
        c = cred.contents
        user = c.UserName or ""
        blob = ctypes.string_at(c.CredentialBlob, c.CredentialBlobSize)
        try:
            secret = blob.decode("utf-16-le").rstrip("\x00")
        except Exception:
            secret = blob.decode("utf-8", "replace").rstrip("\x00")
        return (0, user, secret)
    finally:
        advapi32.CredFree(cred)

import sys

err, user, secret = read_cred("dsh-pet-standalone")
if "--emit" in sys.argv:
    # 仅供本地桥接进程读取：stdout 输出完整密钥，绝不写日志
    if err == 0 and user == "provider/openai-main" and secret:
        print("SECRET=" + secret)
    else:
        print("SECRET-NOT-FOUND code=%d user=%s" % (err, user))
else:
    if err == 0:
        print("CRED-OK user=%s" % user)
        if user == "provider/openai-main":
            if secret:
                print("KEY-PRESENT len=%d" % len(secret))
                print("KEY-PREFIX=%s..." % secret[:6])
            else:
                print("KEY-EMPTY")
        else:
            print("USERNAME-MISMATCH")
    elif err == ERROR_NOT_FOUND:
        print("CRED-NOT-FOUND")
    else:
        print("CRED-ERROR code=%d" % err)
