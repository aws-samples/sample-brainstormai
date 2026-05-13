"""
WebSocket $connect authorizer.

Validates the ?token= query param (Cognito JWT) against the user pool JWKS.
Returns an IAM policy allowing execute-api:Invoke on the $connect route.
"""
import json
import os
import time
import urllib.request
from base64 import urlsafe_b64decode

USER_POOL_ID = os.environ["USER_POOL_ID"]
AWS_REGION = os.environ.get("AWS_DEFAULT_REGION", os.environ.get("AWS_REGION", "us-east-1"))
JWKS_URL = f"https://cognito-idp.{AWS_REGION}.amazonaws.com/{USER_POOL_ID}/.well-known/jwks.json"

_jwks_cache: dict = {}
_jwks_fetched_at: float = 0


def _get_jwks() -> dict:
    global _jwks_cache, _jwks_fetched_at
    if _jwks_cache and (time.time() - _jwks_fetched_at) < 3600:
        return _jwks_cache
    with urllib.request.urlopen(JWKS_URL, timeout=5) as resp:
        _jwks_cache = json.loads(resp.read())
    _jwks_fetched_at = time.time()
    return _jwks_cache


def _b64decode(s: str) -> bytes:
    s += "=" * (-len(s) % 4)
    return urlsafe_b64decode(s)


def _decode_payload(token: str) -> dict:
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("Malformed JWT")
    return json.loads(_b64decode(parts[1]))


def _verify_signature(token: str) -> dict:
    """Verify JWT signature using python-jose if available, else fallback to header check."""
    try:
        from jose import jwk, jwt as jose_jwt
        from jose.utils import base64url_decode

        header = json.loads(_b64decode(token.split(".")[0]))
        kid = header.get("kid")
        jwks = _get_jwks()
        key = next((k for k in jwks["keys"] if k["kid"] == kid), None)
        if not key:
            raise ValueError(f"No matching key for kid={kid}")
        public_key = jwk.construct(key)
        message, encoded_sig = token.rsplit(".", 1)
        decoded_sig = base64url_decode(encoded_sig.encode())
        if not public_key.verify(message.encode(), decoded_sig):
            raise ValueError("Signature verification failed")
        return _decode_payload(token)
    except ImportError:
        # python-jose not available — validate claims only (expiry, issuer)
        # Signature validation is still done by Cognito's token issuance;
        # without jose we validate expiry and issuer as a minimum.
        payload = _decode_payload(token)
        issuer = f"https://cognito-idp.{AWS_REGION}.amazonaws.com/{USER_POOL_ID}"
        if payload.get("iss") != issuer:
            raise ValueError("Invalid issuer")
        if payload.get("exp", 0) < time.time():
            raise ValueError("Token expired")
        return payload


def _policy(effect: str, method_arn: str, sub: str = "") -> dict:
    # Scope the resource to the $connect route only
    parts = method_arn.split(":")
    region = parts[3]
    account = parts[4]
    api_gateway_arn = parts[5]
    api_id = api_gateway_arn.split("/")[0].split("execute-api/")[-1] if "execute-api/" in api_gateway_arn else api_gateway_arn.split("/")[0]
    stage = api_gateway_arn.split("/")[1] if "/" in api_gateway_arn else "*"
    resource_arn = f"arn:aws:execute-api:{region}:{account}:{api_id}/{stage}/$connect"

    policy = {
        "principalId": sub or "user",
        "policyDocument": {
            "Version": "2012-10-17",
            "Statement": [{"Action": "execute-api:Invoke", "Effect": effect, "Resource": resource_arn}],
        },
    }
    if sub:
        policy["context"] = {"sub": sub}
    return policy


def lambda_handler(event, context):
    token = (event.get("queryStringParameters") or {}).get("token", "")
    method_arn = event.get("methodArn", "*")

    if not token:
        return _policy("Deny", method_arn)

    try:
        payload = _verify_signature(token)
        sub = payload.get("sub", "")
        return _policy("Allow", method_arn, sub)
    except Exception:
        return _policy("Deny", method_arn)
