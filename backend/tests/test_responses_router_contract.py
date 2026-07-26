def test_unified_response_router_exposes_required_paths():
    from routers.responses import router

    paths = {route.path for route in router.routes}

    assert "/responses" in paths
    assert "/responses/{item_id}" in paths
    assert "/responses/{item_id}/analyze" in paths
    assert "/responses/{item_id}/decision" in paths
    assert "/responses/{item_id}/outputs" in paths
    assert "/responses/{item_id}/events" in paths
    assert "/responses/{item_id}/analyses" in paths
    assert "/responses/{item_id}/worker-context" in paths
    assert "/responses/{item_id}/worker-analysis" in paths
    assert "/responses/outputs/{output_id}/worker-context" in paths
    assert "/responses/outputs/{output_id}/worker-result" in paths


def test_worker_routes_require_worker_token_dependency():
    from routers.responses import router
    from worker_auth import require_worker_token

    worker_routes = [
        route
        for route in router.routes
        if "worker-" in route.path or "/worker-" in route.path
    ]
    assert worker_routes
    for route in worker_routes:
        dependencies = {
            dependency.call
            for dependency in route.dependant.dependencies
        }
        assert require_worker_token in dependencies
