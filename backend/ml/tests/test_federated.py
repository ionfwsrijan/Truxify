import base64
import pytest
from unittest.mock import patch, MagicMock

VALID_FERNET_KEY = base64.urlsafe_b64encode(b"0123456789abcdef0123456789abcdef").decode()

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
    def test_server_generates_and_persists_encryption_key(self, mock_redis, tmp_path, monkeypatch):
        key_file = tmp_path / "federated" / "encryption.key"
        monkeypatch.setenv("FEDERATED_ENCRYPTION_KEY_FILE", str(key_file))

        from federated.federated_server import FederatedServer
        server = FederatedServer()

        assert key_file.exists()
        assert key_file.read_bytes() == server.encryption_key

    @patch("redis.Redis.from_url")
    def test_server_reuses_persisted_encryption_key_across_restarts(self, mock_redis, tmp_path, monkeypatch):
        key_file = tmp_path / "federated" / "encryption.key"
        monkeypatch.setenv("FEDERATED_ENCRYPTION_KEY_FILE", str(key_file))

        from federated.federated_server import FederatedServer
        first = FederatedServer().encryption_key
        second = FederatedServer().encryption_key

        assert first == second
        assert key_file.read_bytes() == second

    @patch("redis.Redis.from_url")
    def test_server_uses_env_encryption_key_when_set(self, mock_redis, tmp_path, monkeypatch):
        key_file = tmp_path / "federated" / "encryption.key"
        monkeypatch.setenv("FEDERATED_ENCRYPTION_KEY_FILE", str(key_file))
        monkeypatch.setenv("FEDERATED_ENCRYPTION_KEY", VALID_FERNET_KEY)

        from federated.federated_server import FederatedServer
        server = FederatedServer()

        assert server.encryption_key == VALID_FERNET_KEY.encode()
        assert not key_file.exists()
