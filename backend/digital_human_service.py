"""Domain operations for reusable digital humans and talking-video projects."""

from __future__ import annotations

import os
from urllib.parse import urlparse

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from content_jobs import create_job
from config import (
    effective_comfyui_base_url,
    effective_comfyui_shot_seconds,
    get_config,
)
from digital_human_assets import archive_digital_human_asset_ids
from models import (
    ContentJob,
    CreativeAsset,
    DigitalHuman,
    TalkingVideoProject,
    TalkingVideoRender,
    now_utc,
)


class DigitalHumanInUse(ValueError):
    pass


class InvalidTalkingVideo(ValueError):
    pass


_UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "uploads")


def _local_audio_duration_seconds(asset: CreativeAsset) -> float | None:
    import subprocess
    import wave

    path = urlparse(asset.url).path
    prefix = "/api/uploads/"
    if not path.startswith(prefix):
        return None
    filename = os.path.basename(path.removeprefix(prefix))
    local_path = os.path.join(_UPLOADS_DIR, filename)
    if not filename or not os.path.isfile(local_path):
        return None
    try:
        with wave.open(local_path, "rb") as handle:
            rate = handle.getframerate()
            if rate <= 0:
                return None
            return handle.getnframes() / float(rate)
    except wave.Error:
        pass
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                local_path,
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    try:
        return float(result.stdout.strip())
    except ValueError:
        return None


def _local_asset_size(asset: CreativeAsset) -> int | None:
    path = urlparse(asset.url).path
    prefix = "/api/uploads/"
    if not path.startswith(prefix):
        return None
    filename = os.path.basename(path.removeprefix(prefix))
    if not filename:
        return None
    local_path = os.path.join(_UPLOADS_DIR, filename)
    if not os.path.isfile(local_path):
        return None
    return os.path.getsize(local_path)


async def require_media_asset(
    session: AsyncSession,
    asset_id: int,
    accepted_types: set[str],
    max_bytes: int,
) -> CreativeAsset:
    asset = await session.get(CreativeAsset, asset_id)
    if asset is None or asset.asset_type != "media":
        raise InvalidTalkingVideo("创作资产不存在")
    media_type = asset.media_type.lower().split(";", 1)[0].strip()
    if media_type not in accepted_types:
        raise InvalidTalkingVideo("素材格式不支持")
    size = _local_asset_size(asset)
    if size is not None and size > max_bytes:
        raise InvalidTalkingVideo("素材文件超过 32MB 限制")
    return asset


async def create_digital_human(
    session: AsyncSession,
    *,
    name: str,
    portrait_asset_id: int,
    default_environment_asset_id: int,
    voice_sample_asset_id: int | None = None,
    look_prompt: str = "",
    provider: str = "heygen",
) -> tuple[DigitalHuman, ContentJob]:
    clean_name = name.strip()
    if not clean_name:
        raise InvalidTalkingVideo("数字人名称不能为空")
    clean_provider = provider.strip() or "heygen"
    if clean_provider not in {"heygen", "comfyui"}:
        raise InvalidTalkingVideo("不支持的数字人渲染后端")
    await require_media_asset(
        session,
        portrait_asset_id,
        {"image/png", "image/jpeg"},
        32 * 1024 * 1024,
    )
    if voice_sample_asset_id is None:
        raise InvalidTalkingVideo("数字人需要声音样本")
    voice = await require_media_asset(
        session,
        voice_sample_asset_id,
        {"audio/mpeg", "audio/wav", "audio/x-wav"},
        32 * 1024 * 1024,
    )
    if clean_provider == "comfyui":
        duration = _local_audio_duration_seconds(voice)
        if duration is not None and not 2 <= duration <= 15:
            raise InvalidTalkingVideo("ComfyUI 声音样本须为 2–15 秒")
    await require_media_asset(
        session,
        default_environment_asset_id,
        {"image/png", "image/jpeg"},
        32 * 1024 * 1024,
    )
    await archive_digital_human_asset_ids(
        session,
        {
            portrait_asset_id,
            voice_sample_asset_id,
            default_environment_asset_id,
        },
    )
    role = DigitalHuman(
        name=clean_name,
        status="processing",
        provider=clean_provider,
        portrait_asset_id=portrait_asset_id,
        voice_sample_asset_id=voice_sample_asset_id,
        default_environment_asset_id=default_environment_asset_id,
        look_prompt=look_prompt.strip(),
    )
    session.add(role)
    await session.flush()
    job = await create_job(
        session,
        flow="digital_human_setup",
        title=f"初始化数字人 · {role.name}",
        input_data={"digital_human_id": role.id},
        idempotency_key=f"digital-human-setup:{role.id}:1",
        commit=False,
    )
    role.setup_job_id = job.id
    await session.commit()
    await session.refresh(role)
    return role, job


async def create_talking_project(
    session: AsyncSession,
    *,
    title: str,
    digital_human_id: int,
    environment_asset_id: int | None = None,
    source_draft_id: int | None = None,
) -> TalkingVideoProject:
    role = await session.get(DigitalHuman, digital_human_id)
    if role is None or role.status == "archived":
        raise InvalidTalkingVideo("数字人角色不存在或已归档")
    if environment_asset_id is not None:
        await require_media_asset(
            session,
            environment_asset_id,
            {"image/png", "image/jpeg"},
            32 * 1024 * 1024,
        )
        await archive_digital_human_asset_ids(
            session, {environment_asset_id}
        )
    shots: list = []
    if (role.provider or "heygen") == "comfyui":
        from digital_human_shots import new_blank_shot

        _, max_seconds = effective_comfyui_shot_seconds(await get_config())
        shots = [new_blank_shot(max_seconds)]
    project = TalkingVideoProject(
        title=title.strip(),
        digital_human_id=digital_human_id,
        environment_asset_id=environment_asset_id,
        source_draft_id=source_draft_id,
        script_source="draft" if source_draft_id is not None else "manual",
        shots=shots,
    )
    session.add(project)
    await session.commit()
    await session.refresh(project)
    return project


async def create_render(
    session: AsyncSession,
    *,
    project_id: int,
) -> tuple[TalkingVideoRender, ContentJob]:
    project = await session.scalar(
        select(TalkingVideoProject)
        .where(TalkingVideoProject.id == project_id)
        .with_for_update()
    )
    if project is None:
        raise InvalidTalkingVideo("口播作品不存在")
    script = project.script.strip()
    if not script:
        raise InvalidTalkingVideo("请先填写口播脚本")
    role = await session.get(DigitalHuman, project.digital_human_id)
    if role is None or role.status != "ready":
        raise InvalidTalkingVideo("数字人角色尚未就绪")
    if (role.provider or "heygen") == "comfyui":
        raise InvalidTalkingVideo("ComfyUI 作品请按镜头生成后再拼接成片")
    if not role.heygen_avatar_id or not role.heygen_voice_id:
        raise InvalidTalkingVideo("数字人角色缺少 HeyGen 形象或声音")
    environment_asset_id = (
        project.environment_asset_id or role.default_environment_asset_id
    )
    await require_media_asset(
        session,
        environment_asset_id,
        {"image/png", "image/jpeg"},
        32 * 1024 * 1024,
    )
    await archive_digital_human_asset_ids(
        session, {environment_asset_id}
    )
    latest = await session.scalar(
        select(func.max(TalkingVideoRender.version)).where(
            TalkingVideoRender.project_id == project_id
        )
    )
    render = TalkingVideoRender(
        project_id=project.id,
        version=(latest or 0) + 1,
        status="queued",
        script_snapshot=script,
        digital_human_snapshot={
            "id": role.id,
            "name": role.name,
            "heygen_avatar_group_id": role.heygen_avatar_group_id,
            "heygen_avatar_id": role.heygen_avatar_id,
            "heygen_voice_id": role.heygen_voice_id,
        },
        environment_asset_id=environment_asset_id,
    )
    session.add(render)
    await session.flush()
    job = await create_job(
        session,
        flow="digital_human_render",
        title=f"生成口播视频 · {project.title or f'作品 {project.id}'} · V{render.version}",
        input_data={"render_id": render.id},
        idempotency_key=f"talking-video-render:{render.id}",
        commit=False,
    )
    render.job_id = job.id
    await session.commit()
    await session.refresh(render)
    return render, job


async def archive_digital_human(
    session: AsyncSession, role_id: int
) -> DigitalHuman:
    role = await session.get(DigitalHuman, role_id)
    if role is None:
        raise InvalidTalkingVideo("数字人角色不存在")
    role.status = "archived"
    role.archived_at = now_utc()
    await session.commit()
    await session.refresh(role)
    return role


async def delete_digital_human(session: AsyncSession, role_id: int) -> None:
    role = await session.get(DigitalHuman, role_id)
    if role is None:
        raise InvalidTalkingVideo("数字人角色不存在")
    project_count = await session.scalar(
        select(func.count(TalkingVideoProject.id)).where(
            TalkingVideoProject.digital_human_id == role_id
        )
    )
    if project_count:
        raise DigitalHumanInUse("数字人已有口播作品，请改为归档")
    await session.execute(delete(DigitalHuman).where(DigitalHuman.id == role_id))
    await session.commit()


async def select_render(
    session: AsyncSession, project_id: int, render_id: int
) -> TalkingVideoProject:
    project = await session.get(TalkingVideoProject, project_id)
    render = await session.get(TalkingVideoRender, render_id)
    if (
        project is None
        or render is None
        or render.project_id != project_id
        or render.status != "succeeded"
    ):
        raise InvalidTalkingVideo("只能选择已成功的本项目成片")
    project.current_render_id = render.id
    await session.commit()
    await session.refresh(project)
    return project


_PLAN_LLM_TIMEOUT_SEC = 60


def _shot_plan_prompt(
    script: str,
    min_seconds: int,
    max_seconds: int,
    base_delivery: str = "",
    base_presence: str = "",
) -> str:
    from digital_human_shots import (
        CHARS_PER_SECOND,
        DEFAULT_DELIVERY,
        DEFAULT_PRESENCE,
        effective_delivery,
        effective_presence,
    )

    max_chars = max(1, max_seconds * CHARS_PER_SECOND)
    tone = effective_delivery("", base_delivery)
    body = effective_presence("", base_presence)
    return (
        "你是口播分镜规划器。先通读全文，决定本篇数字人的节奏弧："
        "开场 hook → 主体讲解/举例 → 强调或收束，"
        "再把全文切成镜头。\n"
        "所有镜头的 text 按顺序拼接后必须与全文完全一致，"
        "禁止增删改任何字、标点、空格或换行。\n"
        "只输出一个 JSON 对象，不要 markdown，不要解释。\n\n"
        "全文口播在两个标记之间：\n"
        "<<<SCRIPT\n"
        f"{script}\n"
        "SCRIPT>>>\n\n"
        "delivery：本篇总基调，短英文，必须同时写清整体情绪、语速，"
        "以及开场到收束如何变化，"
        f"例如 {tone or DEFAULT_DELIVERY}。"
        "不要只写抽象 mood，不要把参考音频里的情绪或语速抄进来。\n"
        "presence：本篇默认坐姿与可见肢体，短英文，写坐姿、头、手、肩、视线，"
        f"例如 {body or DEFAULT_PRESENCE}。\n"
        "每镜必须根据该镜对白在全文中的内容角色，写独立的 delivery 和 presence："
        "delivery 是这一句的人物情绪 + 讲话节奏/语速；"
        "presence 是这一句的可见表演。"
        "禁止所有镜头共用同一套情绪和语速。"
        "相邻镜头的 delivery 不得完全相同；"
        "若相邻内容功能不同（提问、定义、举例、警告、总结），"
        "情绪或语速必须明显变化，而不是只改两三个词。\n"
        "每镜仍保持坐着对镜头，不要站起、走路或挥手。"
        "不要为了语气改 text。\n"
        f"每段尽量不超过 {max_chars} 个非空白字"
        f"（约 {max_seconds} 秒，按每秒 {CHARS_PER_SECOND} 字）。"
        f"不要无故短于约 {min_seconds} 秒。"
        "优先在。！？；…或换行处切开，必要时再用，、。"
        "framing 只能是 wide、medium、close。\n"
        "输出格式："
        '{"delivery":"...","presence":"...","shots":'
        '[{"text":"...","framing":"medium",'
        '"delivery":"brighter hook, quicker on-set",'
        '"presence":"forward lean, brighter eyes, one-hand beat"}]}'
    )


def _piece_voice_prompt(script: str) -> str:
    from digital_human_shots import DEFAULT_DELIVERY, DEFAULT_PRESENCE

    return (
        "你是口播语气提炼器。根据全文判断本篇数字人该用什么节奏说话。\n"
        "只输出 JSON 对象，不要 markdown，不要镜头列表。\n"
        '格式：{"delivery":"短英文语气","presence":"短英文状态"}\n'
        f"delivery 示例：{DEFAULT_DELIVERY}\n"
        f"presence 示例：{DEFAULT_PRESENCE}\n"
        "delivery 必须写清整体情绪、语速，以及开场→主体→收束的节奏弧，"
        "例如 brighter hook then measured tutorial then warmer close。\n"
        "presence 必须写可见肢体：坐姿、头、手、肩、视线，不要只写 relaxed/natural。\n\n"
        "全文口播：\n<<<SCRIPT\n"
        f"{script}\n"
        "SCRIPT>>>"
    )


def _shot_performance_prompt(script: str, shots: list) -> str:
    lines = [
        f"[{index + 1}] {shot.get('spoken_text') or ''}"
        for index, shot in enumerate(shots)
    ]
    return (
        "你是口播镜头表演导演。镜头 text 已经定稿，禁止改字、禁止增删镜头。\n"
        "只输出 JSON 对象，不要 markdown。\n"
        f'格式：{{"shots":[{{"delivery":"...","presence":"..."}}]}} ，数组长度必须是 {len(shots)}。\n'
        "第 n 项对应镜 n。\n"
        "delivery：这一句的人物情绪 + 讲话节奏/语速，短英文。\n"
        "presence：这一句可见表演（头、眼、手、肩、坐姿微调），短英文，仍坐着对镜头。\n"
        "每镜必须根据该句在全文中的角色来写（hook / 讲解 / 举例 / 强调 / 号召），"
        "相邻镜头的 delivery 和 presence 都必须不同，禁止共用同一套默认语气。\n\n"
        "全文口播：\n<<<SCRIPT\n"
        f"{script}\n"
        "SCRIPT>>>\n\n"
        "镜头列表：\n"
        + "\n".join(lines)
    )


async def _extract_piece_voice(script: str) -> tuple[str, str]:
    import asyncio

    from digital_human_shots import DEFAULT_DELIVERY, DEFAULT_PRESENCE, parse_piece_voice
    from llm import _call

    try:
        raw = await asyncio.wait_for(
            _call(_piece_voice_prompt(script), max_tokens=400),
            timeout=30,
        )
    except Exception:
        return DEFAULT_DELIVERY, DEFAULT_PRESENCE
    delivery, presence = parse_piece_voice(raw)
    return delivery or DEFAULT_DELIVERY, presence or DEFAULT_PRESENCE


async def _request_shot_plan_text(
    script: str,
    min_seconds: int,
    max_seconds: int,
    base_delivery: str = "",
    base_presence: str = "",
) -> str:
    import asyncio

    from llm import _call

    try:
        return await asyncio.wait_for(
            _call(
                _shot_plan_prompt(
                    script, min_seconds, max_seconds, base_delivery, base_presence
                ),
                max_tokens=8000,
            ),
            timeout=_PLAN_LLM_TIMEOUT_SEC,
        )
    except RuntimeError as exc:
        raise InvalidTalkingVideo("请先在设置里配置大模型") from exc
    except TimeoutError as exc:
        raise InvalidTalkingVideo("模型规划超时") from exc
    except Exception as exc:
        raise InvalidTalkingVideo(f"模型规划失败：{str(exc)[:200]}") from exc


async def _assign_distinct_shot_performances(script: str, shots: list) -> list:
    from digital_human_shots import (
        apply_shot_performances,
        fallback_shot_performances,
        parse_shot_performances,
        performances_are_distinct,
    )

    if performances_are_distinct(shots):
        return shots
    import asyncio

    from llm import _call

    try:
        raw = await asyncio.wait_for(
            _call(_shot_performance_prompt(script, shots), max_tokens=4000),
            timeout=45,
        )
        return apply_shot_performances(shots, parse_shot_performances(raw, len(shots)))
    except Exception:
        return apply_shot_performances(shots, fallback_shot_performances(shots))


def _shots_from_plan_text(
    script: str,
    raw: str,
    min_seconds: int,
    max_seconds: int,
    base_delivery: str = "",
    presence: str = "",
) -> tuple[list, str, str]:
    from digital_human_shots import (
        apply_planned_segments,
        fallback_plan_segments,
        parse_shot_plan_document,
    )

    try:
        document = parse_shot_plan_document(raw)
        extracted_delivery = document["delivery"] or base_delivery
        extracted_presence = document["presence"] or presence
        return (
            apply_planned_segments(
                script,
                document["shots"],
                min_seconds,
                max_seconds,
                base_delivery=extracted_delivery,
                presence=extracted_presence,
            ),
            extracted_delivery,
            extracted_presence,
        )
    except InvalidTalkingVideo:
        return (
            apply_planned_segments(
                script,
                fallback_plan_segments(script, max_seconds),
                min_seconds,
                max_seconds,
                base_delivery=base_delivery,
                presence=presence,
            ),
            base_delivery,
            presence,
        )


async def plan_project_shots(
    session: AsyncSession,
    project_id: int,
    script: str | None = None,
) -> TalkingVideoProject:
    from digital_human_shots import apply_planned_segments, fallback_plan_segments

    project = await session.get(TalkingVideoProject, project_id)
    if project is None:
        raise InvalidTalkingVideo("口播作品不存在")
    role = await session.get(DigitalHuman, project.digital_human_id)
    if role is None or (role.provider or "heygen") != "comfyui":
        raise InvalidTalkingVideo("只有 ComfyUI 作品使用镜头规划")
    if any(
        shot.get("status") in {"queued", "running"}
        for shot in list(project.shots or [])
    ):
        raise InvalidTalkingVideo("还有镜头正在生成，请稍后再规划")
    source = project.script if script is None else script
    if not str(source or "").strip():
        raise InvalidTalkingVideo("请先填写全文口播")
    from digital_human_shots import normalize_delivery

    base_delivery = normalize_delivery(getattr(project, "delivery", ""))
    base_presence = normalize_delivery(getattr(project, "presence", ""))
    min_seconds, max_seconds = effective_comfyui_shot_seconds(await get_config())
    await session.rollback()

    extracted_delivery, extracted_presence = await _extract_piece_voice(source)
    if not extracted_delivery:
        extracted_delivery = base_delivery
    if not extracted_presence:
        extracted_presence = base_presence
    try:
        raw = await _request_shot_plan_text(
            source, min_seconds, max_seconds, extracted_delivery, extracted_presence
        )
        shots, plan_delivery, plan_presence = _shots_from_plan_text(
            source,
            raw,
            min_seconds,
            max_seconds,
            extracted_delivery,
            extracted_presence,
        )
        extracted_delivery = plan_delivery or extracted_delivery
        extracted_presence = plan_presence or extracted_presence
    except InvalidTalkingVideo:
        shots = apply_planned_segments(
            source,
            fallback_plan_segments(source, max_seconds),
            min_seconds,
            max_seconds,
            base_delivery=extracted_delivery,
            presence=extracted_presence,
        )

    shots = await _assign_distinct_shot_performances(source, shots)

    project = await session.scalar(
        select(TalkingVideoProject)
        .where(TalkingVideoProject.id == project_id)
        .with_for_update()
    )
    if project is None:
        raise InvalidTalkingVideo("口播作品不存在")
    if any(
        shot.get("status") in {"queued", "running"}
        for shot in list(project.shots or [])
    ):
        raise InvalidTalkingVideo("还有镜头正在生成，请稍后再规划")
    project.shots = shots
    project.script = source
    from digital_human_shots import DEFAULT_DELIVERY, DEFAULT_PRESENCE

    project.delivery = extracted_delivery or DEFAULT_DELIVERY
    project.presence = extracted_presence or DEFAULT_PRESENCE
    await session.commit()
    await session.refresh(project)
    return project


async def save_project_shots(
    session: AsyncSession,
    project_id: int,
    raw_shots: list,
) -> TalkingVideoProject:
    from digital_human_shots import normalize_shots, script_from_shots

    project = await session.scalar(
        select(TalkingVideoProject)
        .where(TalkingVideoProject.id == project_id)
        .with_for_update()
    )
    if project is None:
        raise InvalidTalkingVideo("口播作品不存在")
    role = await session.get(DigitalHuman, project.digital_human_id)
    if role is None or (role.provider or "heygen") != "comfyui":
        raise InvalidTalkingVideo("只有 ComfyUI 作品使用镜头列表")
    min_seconds, max_seconds = effective_comfyui_shot_seconds(await get_config())
    project.shots = normalize_shots(raw_shots, min_seconds, max_seconds)
    project.script = script_from_shots(project.shots)
    await session.commit()
    await session.refresh(project)
    return project


async def enqueue_shot_render(
    session: AsyncSession,
    project_id: int,
    shot_id: str,
) -> tuple[dict, ContentJob]:
    from digital_human_shots import (
        assign_shared_seed,
        find_shot,
        replace_shot,
    )

    if not effective_comfyui_base_url(await get_config()):
        raise InvalidTalkingVideo("请先配置 ComfyUI 地址")
    project = await session.scalar(
        select(TalkingVideoProject)
        .where(TalkingVideoProject.id == project_id)
        .with_for_update()
    )
    if project is None:
        raise InvalidTalkingVideo("口播作品不存在")
    role = await session.get(DigitalHuman, project.digital_human_id)
    if role is None or role.status != "ready":
        raise InvalidTalkingVideo("数字人角色尚未就绪")
    if not role.look_asset_id:
        raise InvalidTalkingVideo("请先完成定妆图合成")
    if not role.voice_sample_asset_id:
        raise InvalidTalkingVideo("请先为数字人上传 2–15 秒声音样本")
    shots = list(project.shots or [])
    shot = find_shot(shots, shot_id)
    if shot["status"] in {"queued", "running"}:
        raise InvalidTalkingVideo("该镜头正在生成")
    job = await create_job(
        session,
        flow="digital_human_shot_render",
        title=f"生成口播镜头 · {project.title or f'作品 {project.id}'}",
        input_data={"project_id": project.id, "shot_id": shot_id},
        commit=False,
    )
    shots, seed = assign_shared_seed(shots)
    state = dict(find_shot(shots, shot_id).get("provider_state") or {})
    state.pop("prompt_id", None)
    state.pop("auto_queue", None)
    state["seed"] = seed
    project.shots = replace_shot(
        shots,
        shot_id,
        {
            "status": "queued",
            "job_id": job.id,
            "error": "",
            "seed": seed,
            "provider_state": state,
        },
    )
    await session.commit()
    await session.refresh(project)
    return find_shot(list(project.shots or []), shot_id), job


async def enqueue_pending_shot_renders(
    session: AsyncSession,
    project_id: int,
) -> list[ContentJob]:
    project = await session.get(TalkingVideoProject, project_id)
    if project is None:
        raise InvalidTalkingVideo("口播作品不存在")

    jobs: list[ContentJob] = []
    for shot in list(project.shots or []):
        if shot.get("status") not in {"draft", "failed"}:
            continue
        _, job = await enqueue_shot_render(session, project_id, str(shot["id"]))
        jobs.append(job)
    return jobs


async def create_stitch(
    session: AsyncSession,
    project_id: int,
) -> tuple[TalkingVideoRender, ContentJob]:
    from digital_human_shots import script_from_shots

    project = await session.scalar(
        select(TalkingVideoProject)
        .where(TalkingVideoProject.id == project_id)
        .with_for_update()
    )
    if project is None:
        raise InvalidTalkingVideo("口播作品不存在")
    role = await session.get(DigitalHuman, project.digital_human_id)
    if role is None or role.status != "ready":
        raise InvalidTalkingVideo("数字人角色尚未就绪")
    shots = list(project.shots or [])
    if not shots:
        raise InvalidTalkingVideo("请先添加镜头")
    for shot in shots:
        if shot.get("status") != "succeeded" or not shot.get("clip_asset_id"):
            raise InvalidTalkingVideo("还有镜头未生成成功")
        if shot.get("status") == "running":
            raise InvalidTalkingVideo("还有镜头正在生成")
    environment_asset_id = (
        project.environment_asset_id or role.default_environment_asset_id
    )
    latest = await session.scalar(
        select(func.max(TalkingVideoRender.version)).where(
            TalkingVideoRender.project_id == project_id
        )
    )
    render = TalkingVideoRender(
        project_id=project.id,
        version=(latest or 0) + 1,
        status="queued",
        script_snapshot=script_from_shots(shots),
        digital_human_snapshot={
            "id": role.id,
            "name": role.name,
            "provider": role.provider or "comfyui",
            "look_asset_id": role.look_asset_id,
        },
        shots_snapshot=shots,
        environment_asset_id=environment_asset_id,
    )
    session.add(render)
    await session.flush()
    job = await create_job(
        session,
        flow="digital_human_stitch",
        title=f"拼接口播成片 · {project.title or f'作品 {project.id}'} · V{render.version}",
        input_data={"render_id": render.id},
        idempotency_key=f"talking-stitch:{render.id}",
        commit=False,
    )
    render.job_id = job.id
    await session.commit()
    await session.refresh(render)
    return render, job
