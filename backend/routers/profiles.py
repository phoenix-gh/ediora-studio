from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import profile_manager as pm

router = APIRouter(prefix="/profiles", tags=["profiles"])


class SoulBody(BaseModel):
    content: str


class ToggleBody(BaseModel):
    name: str
    enabled: bool


@router.get("")
def list_profiles():
    return {"profiles": pm.list_profiles()}


@router.get("/{name}")
def get_profile(name: str):
    try:
        return pm.get_profile_detail(name)
    except ValueError:
        raise HTTPException(400, "invalid profile name")
    except FileNotFoundError:
        raise HTTPException(404, "profile not found")


@router.put("/{name}/soul")
def put_soul(name: str, body: SoulBody):
    try:
        pm.write_soul(name, body.content)
        return {"ok": True}
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError:
        raise HTTPException(400, "invalid profile name")
    except FileNotFoundError:
        raise HTTPException(404, "profile not found")


@router.post("/{name}/toolsets")
def post_toolset(name: str, body: ToggleBody):
    try:
        pm.set_toolset(name, body.name, body.enabled)
        return {"ok": True}
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError:
        raise HTTPException(404, "profile not found")
    except RuntimeError as e:
        raise HTTPException(502, str(e))


@router.post("/{name}/mcp")
def post_mcp(name: str, body: ToggleBody):
    try:
        pm.set_mcp_server(name, body.name, body.enabled)
        return {"ok": True}
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError:
        raise HTTPException(404, "profile not found")
    except RuntimeError as e:
        raise HTTPException(502, str(e))
