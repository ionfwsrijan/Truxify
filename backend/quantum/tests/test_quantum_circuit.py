import os
import sys
from unittest import mock

import networkx as nx
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from quantum_circuit import QUBOFormatter, QuantumCircuitDesigner  # noqa: E402

from qiskit_algorithms.minimum_eigensolvers import NumPyMinimumEigensolver  # noqa: E402


class _FakeJob:
    """Fake AerSimulator job returning empty counts."""

    def result(self):
        class _FakeResult:
            def get_counts(self):
                return {}

        return _FakeResult()


def _selected_edges(formatter, result):
    """Map a solver result back to the set of selected graph edges."""
    selected = set()
    for var_name, value in zip(formatter.variables, result.x):
        if value is not None and abs(value - 1) < 1e-6:
            _, u, v = var_name.split('_')
            selected.add((u, v))
    return selected


def _node_degrees(edges, nodes):
    deg = {n: 0 for n in nodes}
    for u, v in edges:
        deg[u] += 1
        deg[v] += 1
    return deg


def _square_graph():
    g = nx.Graph()
    g.add_edge('A', 'B', weight=1.0)
    g.add_edge('B', 'C', weight=2.0)
    g.add_edge('C', 'D', weight=1.0)
    g.add_edge('D', 'A', weight=2.0)
    return g


def test_route_optimization_non_empty_cycle():
    formatter = QUBOFormatter()
    graph = _square_graph()

    qubo = formatter.formulate_route_optimization(graph)
    result = formatter.solve_qubo(qubo, eigensolver=NumPyMinimumEigensolver())

    assert result['success'] is True
    selected = _selected_edges(formatter, result)

    # A valid route must select at least one edge (not the empty route).
    assert len(selected) >= 1

    # Every node must have degree exactly 2 -> a single cycle.
    degrees = _node_degrees(selected, list(graph.nodes()))
    assert all(d == 2 for d in degrees.values())


def test_route_optimization_triangle():
    formatter = QUBOFormatter()
    graph = nx.Graph()
    graph.add_edge('A', 'B', weight=1.0)
    graph.add_edge('B', 'C', weight=1.0)
    graph.add_edge('C', 'A', weight=1.0)

    qubo = formatter.formulate_route_optimization(graph)
    result = formatter.solve_qubo(qubo, eigensolver=NumPyMinimumEigensolver())

    assert result['success'] is True
    selected = _selected_edges(formatter, result)
    assert len(selected) >= 1
    degrees = _node_degrees(selected, list(graph.nodes()))
    assert all(d == 2 for d in degrees.values())


def test_run_circuit_empty_counts_does_not_raise():
    designer = QuantumCircuitDesigner(num_qubits=2)
    circuit = designer.create_basic_circuit()

    with mock.patch('quantum_circuit.AerSimulator') as mock_simulator, \
            mock.patch('qiskit.transpile', return_value=circuit):
        mock_simulator.return_value.run.return_value = _FakeJob()
        result = designer.run_circuit(circuit, shots=1024)

    assert result['success'] is True
    assert result['counts'] == {}
    assert result['most_frequent'] is None
    assert 'warning' in result
