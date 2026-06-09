from fastapi import APIRouter

import profile_manager as pm

router = APIRouter(prefix="/skills", tags=["skills"])


@router.get("")
def list_skills():
    """All project skills available to install (metadata only)."""
    return {"skills": pm.list_project_skills()}
