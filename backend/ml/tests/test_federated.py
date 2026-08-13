import json
import pytest
from unittest.mock import patch, MagicMock

class TestFederated:
    @patch("redis.Redis.from_url")
    def test_federated_server_init(self, mock_redis):
        from federated.federated_server import FederatedServer
        server = FederatedServer()
        assert server.round == 0
        assert server.min_clients == 3

    @patch("redis.Redis.from_url")
    def test_federated_client_init(self, mock_redis):
        from federated.federated_client import FederatedClient
        client = FederatedClient(client_id="client-101")
        assert client.client_id == "client-101"

    @patch("redis.Redis.from_url")
    def test_start_round_tracks_selected_clients(self, mock_redis):
        from federated.federated_server import FederatedServer

        mock_redis.return_value.smembers.return_value = {
            b"client-101", b"client-102", b"client-103"
        }
        server = FederatedServer()
        result = server.start_round()

        assert result is not None
        assert set(server.round_clients) == {"client-101", "client-102", "client-103"}

    @patch("redis.Redis.from_url")
    def test_receive_client_update_aggregates_at_selected_count(self, mock_redis):
        from federated.federated_server import FederatedServer

        server = FederatedServer()
        server.round_clients = ["client-101", "client-102", "client-103"]
        server.global_weights = server.model.get_weights()

        weights_json = json.dumps([w.tolist() for w in server.model.get_weights()])
        encrypted = server.cipher.encrypt(weights_json.encode())

        with patch.object(server, "_aggregate_weights") as mock_aggregate:
            server.receive_client_update("client-101", encrypted)
            server.receive_client_update("client-102", encrypted)
            assert mock_aggregate.call_count == 0

            server.receive_client_update("client-103", encrypted)
            assert mock_aggregate.call_count == 1
