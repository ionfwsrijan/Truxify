import pytest

torch_geometric = pytest.importorskip("torch_geometric")
from gnn.models import GNNRouteModel, GraphNetworkBuilder


class TestGNNModel:
    def test_route_gnn_init(self):
        model = GNNRouteModel(input_dim=10, hidden_dim=32, output_dim=2)
        assert model is not None
        assert hasattr(model, 'forward')


class TestGraphNetworkBuilder:
    def test_build_road_network_is_isolated_per_call(self):
        builder = GraphNetworkBuilder()

        graph_a = builder.build_road_network(
            [{'id': 'A', 'lat': 0, 'lng': 0}],
            []
        )
        graph_b = builder.build_road_network(
            [{'id': 'B', 'lat': 1, 'lng': 1}],
            []
        )

        assert 'A' in graph_a.nodes
        assert 'B' not in graph_a.nodes
        assert 'B' in graph_b.nodes
        assert 'A' not in graph_b.nodes

    def test_get_pytorch_data_uses_passed_graph(self):
        builder = GraphNetworkBuilder()

        graph = builder.build_road_network(
            [{'id': 'A', 'lat': 0, 'lng': 0}, {'id': 'B', 'lat': 1, 'lng': 1}],
            [{'source': 'A', 'target': 'B', 'distance': 100, 'time': 10}]
        )
        data = builder.get_pytorch_data(graph)

        assert set(data.node_map) == {'A', 'B'}
        assert data.edge_index.shape[1] == 1
