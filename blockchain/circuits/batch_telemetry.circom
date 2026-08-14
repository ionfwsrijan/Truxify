pragma circom 2.1.6;

include "./poseidon.circom";

template BatchTelemetryTransition(N) {
    signal input initialMerkleRoot;
    signal input finalMerkleRoot;
    signal input telemetryPings[N][2]; // [lat_coord, lng_coord]
    
    signal computedHashes[N];
    
    // Hash each telemetry ping with the real Poseidon permutation
    component hashers[N];
    for (var i = 0; i < N; i++) {
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== telemetryPings[i][0];
        hashers[i].inputs[1] <== telemetryPings[i][1];
        computedHashes[i] <== hashers[i].out;
    }
    
    // Fold the ping hashes into the merkle root: root_{i+1} = Poseidon(root_i, Poseidon(ping_i))
    signal roots[N+1];
    roots[0] <== initialMerkleRoot;
    component fold[N];
    for (var i = 0; i < N; i++) {
        fold[i] = Poseidon(2);
        fold[i].inputs[0] <== roots[i];
        fold[i].inputs[1] <== computedHashes[i];
        roots[i+1] <== fold[i].out;
    }
    
    // Claimed final root must match the computed transition
    finalMerkleRoot === roots[N];
}

component main {public [initialMerkleRoot, finalMerkleRoot]} = BatchTelemetryTransition(4);
