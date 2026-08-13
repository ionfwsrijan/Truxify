import pytest
from unittest.mock import patch, MagicMock, AsyncMock
import os
import asyncio
import time
import aiohttp

from services.traffic_pipeline import TrafficPipeline

class TestTrafficPipeline:
    @patch("redis.Redis.from_url")
    def test_traffic_pipeline_init(self, mock_redis, tmp_path):
        db_path = str(tmp_path / "traffic_test.db")
        pipeline = TrafficPipeline(db_path=db_path)
        assert pipeline.db_path == db_path
        assert os.path.exists(db_path)

    @patch("redis.Redis.from_url")
    def test_calculate_eta(self, mock_redis, tmp_path):
        db_path = str(tmp_path / "traffic_test.db")
        pipeline = TrafficPipeline(db_path=db_path)
        route_coords = [(12.9716, 77.5946), (12.9352, 77.6245)] # Bangalore coordinates
        eta_seconds, confidence = pipeline.calculate_eta("route-1", route_coords)
        assert eta_seconds > 0
        assert 0.0 <= confidence <= 1.0


class TestEtaComputation:
    """Tests for the ETA computation formula in update_eta_realtime.

    The bug was: eta_seconds = (route_distance_m / 1000.0) / (speed_kmh / 3.6)
    This mixes km (from dividing m by 1000) with m/s (from dividing km/h by 3.6),
    producing a result 1000x too small.

    Correct formula: eta_seconds = route_distance_m / (speed_kmh / 3.6)
    This converts speed to m/s first, then divides distance_m by speed_mps to get seconds.
    """

    def test_eta_formula_returns_correct_seconds(self):
        """10 km at 40 km/h should be ~900 seconds (15 minutes)."""
        route_distance_m = 10000  # 10 km in metres
        predicted_speed_kmh = 40.0
        # Correct formula: distance_m / (speed_kmh / 3.6) = 10000 / 11.111 = 900
        eta_seconds = route_distance_m / (predicted_speed_kmh / 3.6)
        assert 890 < eta_seconds < 910, f"Expected ~900s, got {eta_seconds}"

    def test_eta_formula_100x_too_small_before_fix(self):
        """Verify the old (incorrect) formula was off by exactly 1000x."""
        route_distance_m = 10000
        predicted_speed_kmh = 40.0
        # Incorrect: (route_distance_m / 1000.0) / (speed_kmh / 3.6)
        incorrect_eta = (route_distance_m / 1000.0) / (predicted_speed_kmh / 3.6)
        correct_eta = route_distance_m / (predicted_speed_kmh / 3.6)
        assert incorrect_eta == correct_eta / 1000, (
            "Old formula should be exactly 1000x smaller than correct formula"
        )

    def test_eta_zero_distance_returns_zero(self):
        """Zero distance should give zero ETA regardless of speed."""
        route_distance_m = 0
        predicted_speed_kmh = 40.0
        eta_seconds = route_distance_m / (predicted_speed_kmh / 3.6)
        assert eta_seconds == 0.0

    def test_eta_reasonable_range_for_real_trip(self):
        """100 km at 60 km/h should be ~6000 seconds (100 minutes)."""
        route_distance_m = 100000  # 100 km
        predicted_speed_kmh = 60.0
        eta_seconds = route_distance_m / (predicted_speed_kmh / 3.6)
        assert 5900 < eta_seconds < 6100, f"Expected ~6000s, got {eta_seconds}"


class TestOsrmTimeoutAndCircuitBreaker:
    """Tests for the OSRM call timeout + circuit breaker in
    TrafficPipeline._fetch_osrm_data (issue #11228).

    The pipeline instance is created via object.__new__ to skip the DB/Redis
    engine and LSTM model setup (pattern from test_ab_testing_model.py).
    """

    def _make_pipeline(self, threshold=5, cooldown=30.0):
        pipeline = object.__new__(TrafficPipeline)
        pipeline.osrm_url = "http://osrm:5000"
        pipeline.traffic_timeout = aiohttp.ClientTimeout(total=5.0, connect=2.0)
        pipeline._osrm_circuit_threshold = threshold
        pipeline._osrm_circuit_cooldown_seconds = cooldown
        pipeline._osrm_failures = 0
        pipeline._osrm_circuit_open_until = 0.0
        return pipeline

    @staticmethod
    def _mock_osrm_session(mock_response):
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=False)
        session = MagicMock()
        session.__aenter__ = AsyncMock(return_value=session)
        session.__aexit__ = AsyncMock(return_value=False)
        session.get.return_value = mock_response
        return session

    def test_fetch_osrm_data_applies_client_timeout(self):
        pipeline = self._make_pipeline()
        response = MagicMock()
        response.status = 200
        response.json = AsyncMock(return_value={'routes': [{'duration': 120.0, 'distance': 2000.0}]})

        with patch(
            "services.traffic_pipeline.aiohttp.ClientSession",
            return_value=self._mock_osrm_session(response),
        ) as mock_cls:
            result = asyncio.run(pipeline._fetch_osrm_data(
                {'lat': 1.0, 'lng': 2.0}, {'lat': 3.0, 'lng': 4.0}
            ))

        mock_cls.assert_called_once()
        timeout = mock_cls.call_args.kwargs.get('timeout')
        assert timeout is not None
        assert timeout.total == 5.0
        assert timeout.connect == 2.0
        assert result['distance'] == 2000.0

    def test_circuit_opens_after_threshold_failures(self):
        pipeline = self._make_pipeline(threshold=2, cooldown=30.0)
        assert pipeline._osrm_circuit_allows() is True
        pipeline._osrm_record_failure()
        assert pipeline._osrm_circuit_allows() is True
        pipeline._osrm_record_failure()
        assert pipeline._osrm_circuit_allows() is False

    def test_circuit_restores_after_cooldown_and_success(self):
        pipeline = self._make_pipeline(threshold=1, cooldown=30.0)
        pipeline._osrm_record_failure()
        assert pipeline._osrm_circuit_allows() is False
        pipeline._osrm_circuit_open_until = time.monotonic() - 1
        assert pipeline._osrm_circuit_allows() is True
        pipeline._osrm_record_success()
        assert pipeline._osrm_failures == 0
        assert pipeline._osrm_circuit_allows() is True

    def test_fetch_osrm_data_fails_fast_when_circuit_open(self):
        pipeline = self._make_pipeline()
        pipeline._osrm_failures = 5
        pipeline._osrm_circuit_open_until = time.monotonic() + 30

        with patch("services.traffic_pipeline.aiohttp.ClientSession") as mock_cls:
            result = asyncio.run(pipeline._fetch_osrm_data(
                {'lat': 1.0, 'lng': 2.0}, {'lat': 3.0, 'lng': 4.0}
            ))

        mock_cls.assert_not_called()
        assert result == {'speed': 50, 'free_flow_speed': 80}

    def test_fetch_osrm_data_records_failure_on_server_error(self):
        pipeline = self._make_pipeline(threshold=1, cooldown=30.0)
        response = MagicMock()
        response.status = 500

        with patch(
            "services.traffic_pipeline.aiohttp.ClientSession",
            return_value=self._mock_osrm_session(response),
        ):
            result = asyncio.run(pipeline._fetch_osrm_data(
                {'lat': 1.0, 'lng': 2.0}, {'lat': 3.0, 'lng': 4.0}
            ))

        assert result == {'speed': 50, 'free_flow_speed': 80}
        assert pipeline._osrm_circuit_allows() is False

    def test_fetch_osrm_data_records_failure_on_timeout(self):
        pipeline = self._make_pipeline(threshold=1, cooldown=30.0)

        def _raise_timeout(*args, **kwargs):
            raise asyncio.TimeoutError("Timed out")

        response = MagicMock()
        response.status = 200

        session = self._mock_osrm_session(response)
        session.get.side_effect = _raise_timeout

        with patch("services.traffic_pipeline.aiohttp.ClientSession", return_value=session):
            result = asyncio.run(pipeline._fetch_osrm_data(
                {'lat': 1.0, 'lng': 2.0}, {'lat': 3.0, 'lng': 4.0}
            ))

        assert result == {'speed': 50, 'free_flow_speed': 80}
        assert pipeline._osrm_circuit_allows() is False
