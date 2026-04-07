"""
CLI-мост для Node: запрос PIN Supercell по email и game key (laser|scroll|magic).
Печатает в stdout одну строку JSON. Логи — только в stderr.

Нужны файлы cache/<game>.pkl (как в оригинальном плагине FunPay).
Зависимости: pip install httpx fake-useragent
"""

from __future__ import annotations

import argparse
import base64
import hmac
import json
import os
import pickle
import random
import secrets
import sys
import time
import urllib.parse
from contextlib import suppress

try:
    import httpx
    from fake_useragent import UserAgent
except ImportError:
    print(
        json.dumps(
            {
                "ok": False,
                "error": "Установите зависимости: pip install httpx fake-useragent",
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    sys.exit(1)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_FOLDER = os.path.join(SCRIPT_DIR, "cache")
BIN_STATE_FILE = os.path.join(CACHE_FOLDER, "last_bin.json")

recaptcha_url = "https://www.recaptcha.net/recaptcha/api3/mrr"
sc_api_url = "https://id.supercell.com/api/account/v2/pinAuthentication.start"

PHONE_MODELS = [
    "iPhone14,5",
    "iPhone14,7",
    "iPhone15,2",
    "iPhone15,4",
    "iPhone16,1",
    "iPhone16,2",
    "iPhone17,1",
    "iPhone17,3",
]
IOS_VERSIONS = ["17.4", "17.5", "17.6", "18.0", "18.1", "18.2"]


def shuffle(base, seed):
    size, numbers, x = len(base), list(range(len(base))), seed
    for i in range(size):
        j = (size - 1) - i
        x = (0x19660D * x + 0x3C6EF35F) & 0xFFFFFFFF
        k, v = x % (j + 1), numbers[j]
        numbers[j], numbers[k] = numbers[k], v
    offsets = [0] * size
    for i in range(size):
        offsets[numbers[i]] = i
    return bytes([base[offsets[i]] for i in range(size)])


keychain = {
    "laser": {
        "key": shuffle(
            bytes.fromhex(
                "4d5875b5afc4aee2cffa68dfe5788d730e602e1cb6061ff3c3cb5ba37bd4bf58"
            ),
            42,
        ),
        "scid_version": "1.12.16",
        "version": "65.165",
        "recaptchasitekey": "6Lf3ThsqAAAAABuxaWIkogybKxfxoKxtR-aq5g7l",
        "name": "Brawl Stars",
        "packet": "laser",
    },
    "scroll": {
        "key": shuffle(
            bytes.fromhex(
                "884e0665320eca797ac8bfed384b485b84039b441cbd0995483a796569eff170"
            ),
            42,
        ),
        "scid_version": "1.12.11",
        "version": "13.300.33",
        "recaptchasitekey": "6LcwMCIqAAAAAEbYq9yxb6JwEz-yBTwTfYrjAOSl",
        "name": "Clash Royale",
        "packet": "clashroyale",
    },
    "magic": {
        "key": shuffle(
            bytes.fromhex(
                "ad161215d2216483441a3fc5ba0f18b108441584ba888e0f66d43a38f870c1b9"
            ),
            42,
        ),
        "scid_version": "1.12.8",
        "version": "18.0.10",
        "recaptchasitekey": "6Lf9SSIqAAAAAHfB6t8O9gGu6-Y_oHNkFtlMO2eT",
        "name": "Clash of Clans",
        "packet": "clashofclans",
    },
}


def ensure_cache_folder():
    if not os.path.exists(CACHE_FOLDER):
        os.makedirs(CACHE_FOLDER)
    if not os.path.exists(BIN_STATE_FILE):
        with open(BIN_STATE_FILE, "w", encoding="utf-8") as f:
            json.dump({}, f, indent=4, ensure_ascii=False)


def get_next_bin(game):
    pkl_file = os.path.join(CACHE_FOLDER, f"{game}.pkl")
    try:
        ensure_cache_folder()
        try:
            with open(BIN_STATE_FILE, "r", encoding="utf-8") as f:
                state = json.load(f)
        except Exception:
            state = {}
        last = state.get(game, {}).get("last_index", -1)
        if not os.path.exists(pkl_file):
            return None
        with open(pkl_file, "rb") as f:
            bin_data = pickle.load(f)
        if not bin_data:
            return None
        idx = (last + 1) % len(bin_data)
        state[game] = {"last_index": idx}
        with open(BIN_STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=4, ensure_ascii=False)
        return bin_data[idx]
    except (pickle.UnpicklingError, EOFError, IndexError):
        with suppress(OSError):
            os.remove(pkl_file)
        return None
    except Exception:
        return None


def generate_sig(data, method, useragent, did, game):
    key = keychain[game]["key"]
    t = int(time.time())
    raw = f"{t}POST/{method}{urllib.parse.urlencode(data)}user-agent={useragent}x-supercell-device-id={did}"
    sig = (
        base64.b64encode(hmac.digest(key, raw.encode(), "sha256"))
        .decode()
        .replace("+", "-")
        .replace("/", "_")
        .replace("=", "")
    )
    return f"RFPv1 Timestamp={t},SignedHeaders=user-agent;x-supercell-device-id,Signature={sig}"


def get_recaptcha(game):
    data = get_next_bin(game)
    if not data:
        return None
    headers = {
        "User-Agent": UserAgent().random,
        "Connection": "Keep-Alive",
        "Accept-Encoding": "gzip",
        "Host": "www.recaptcha.net",
        "Content-Type": "application/x-protobuffer",
    }
    try:
        r = httpx.post(recaptcha_url, headers=headers, data=data, timeout=20)
        content = str(r.content)
        start = content.find("0cAFcW")
        return content[start:].split("\\x")[0] if start != -1 else None
    except Exception:
        return None


def _build_ua(game, model=None, os_version=None):
    model = model or random.choice(PHONE_MODELS)
    os_version = os_version or random.choice(IOS_VERSIONS)
    gc = keychain[game]
    ua = (
        f"scid/{gc['scid_version']} (iOS {os_version}; {game}-prod; {model}) "
        f"com.supercell.{gc['packet']}/{gc['version']}"
    )
    return ua, model, os_version


def send_request(email, game):
    did = secrets.token_hex(8)
    recaptcha = get_recaptcha(game)
    if not recaptcha:
        return None, did, None, "Не удалось получить reCAPTCHA (проверьте cache/*.pkl)"

    ua, model, os_version = _build_ua(game)
    ua_info = {"ua": ua, "model": model, "os_version": os_version}

    data = {
        "scope": "account/connect",
        "identifier": email,
        "identifierType": "EMAIL",
        "application": f"{game}-prod",
        "recaptchaToken": recaptcha,
        "recaptchaSiteKey": keychain[game]["recaptchasitekey"],
        "intent": "LOGIN",
    }
    encoded_data = urllib.parse.urlencode(data)
    headers = {
        "accept": "*/*",
        "accept-encoding": "gzip, deflate",
        "accept-language": "ru",
        "content-length": str(len(encoded_data)),
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        "host": "id.supercell.com",
        "user-agent": ua,
        "x-supercell-device-id": did,
        "x-supercell-request-forgery-protection": generate_sig(
            data, "api/account/v2/pinAuthentication.start", ua, did, game
        ),
    }
    try:
        r = httpx.post(sc_api_url, headers=headers, data=encoded_data, timeout=20)
        try:
            resp_json = r.json()
            state_token = (resp_json.get("data") or {}).get("state")
            if state_token:
                ua_info["state"] = state_token
        except Exception:
            pass
        return r, did, ua_info, None
    except Exception as e:
        return None, did, ua_info, str(e) or "Ошибка HTTP-запроса к Supercell"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--game", required=True, choices=tuple(keychain.keys()))
    args = parser.parse_args()
    game = args.game
    email = args.email.strip()

    if game not in keychain:
        print(
            json.dumps({"ok": False, "error": f"Неизвестная игра: {game}"}, ensure_ascii=False),
            flush=True,
        )
        return 1

    pkl_path = os.path.join(CACHE_FOLDER, f"{game}.pkl")
    if not os.path.isfile(pkl_path):
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"Нет файла {pkl_path}. Скопируйте {game}.pkl из архива плагина в папку cache/",
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 1

    resp, device_id, ua_info, err = send_request(email, game)
    if err:
        print(json.dumps({"ok": False, "error": err}, ensure_ascii=False), flush=True)
        return 1
    if not resp:
        print(
            json.dumps({"ok": False, "error": "Нет ответа от Supercell"}, ensure_ascii=False),
            flush=True,
        )
        return 1
    if resp.status_code != 200:
        body = ""
        with suppress(Exception):
            body = resp.text[:500]
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"Supercell HTTP {resp.status_code}",
                    "httpStatus": resp.status_code,
                    "bodyPreview": body,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 1

    out = {
        "ok": True,
        "gameKey": game,
        "gameName": keychain[game]["name"],
        "email": email,
        "deviceId": device_id,
    }
    if ua_info and ua_info.get("state"):
        out["hasStateToken"] = True
    print(json.dumps(out, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
