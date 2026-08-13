import pytest

torch_geometric = pytest.importorskip("torch_geometric")
from gnn.models import GNNRouteModel, RouteOptimizer, UntrainedModelError

class TestGNNModel:
    def test_route_gnn_init(self):
        model = GNNRouteModel()
        assert model is not None
        assert hasattr(model, 'forward')

class TestRouteOptimizerGuards:
    def test_train_refuses_empty_dataset(self):
        optimizer = RouteOptimizer()
        with pytest.raises(ValueError):
            optimizer.train([], [], epochs=1)

    def test_optimize_refuses_untrained_model(self):
        optimizer = RouteOptimizer()
        assert optimizer.trained is False
        with pytest.raises(UntrainedModelError):
            optimizer.optimize_route("a", "b", None)

    def test_loaded_model_is_marked_trained(self, tmp_path):
        optimizer = RouteOptimizer()
        path = str(tmp_path / "gnn_route.pth")
        optimizer.save_model(path)

        loaded = RouteOptimizer()
        loaded.load_model(path)
        assert loaded.trained is True
