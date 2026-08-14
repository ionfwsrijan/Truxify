pragma circom 2.0.0;

include "./poseidon.circom";

// ZK-SNARK circuit for KYC verification.
//
// `verified` is no longer a prover-supplied input. A proof is valid (the
// authority has approved this user's document) only when every constraint
// below holds, so the validity outcome is derived from an authority-issued
// commitment instead of being chosen by the prover:
//   documentHash === Poseidon-fold(name || licenseNumber || rcNumber || insuranceNumber)
//   authorityCommitment === Poseidon(Poseidon(Poseidon(documentHash, userId), authorityPublicKey), issuerSignature)
// userId and authorityCommitment are public inputs so the verifier contract can
// bind the proof to the caller (input[0] === user) and to the authority-issued
// commitment. issuerSignature is private: only a prover holding the
// authority-signed record can reproduce the commitment.
template KYCVerification() {
    signal input documentHash;
    signal input userId;
    signal input authorityPublicKey;
    signal input authorityCommitment;
    signal input issuerSignature;
    signal input name[100];
    signal input licenseNumber[50];
    signal input rcNumber[50];
    signal input insuranceNumber[50];

    // Commit to the exact raw document fields with the real Poseidon hash
    // (binary fold since the vendored Poseidon is t=3), so documentHash cannot
    // be swapped for an arbitrary value.
    component docFold = Fold(250);
    for (var i = 0; i < 100; i++) {
        docFold.values[i] <== name[i];
    }
    for (var i = 0; i < 50; i++) {
        docFold.values[100 + i] <== licenseNumber[i];
    }
    for (var i = 0; i < 50; i++) {
        docFold.values[150 + i] <== rcNumber[i];
    }
    for (var i = 0; i < 50; i++) {
        docFold.values[200 + i] <== insuranceNumber[i];
    }
    docFold.out === documentHash;

    // Fold the caller's identity into the hash chain so the proof is bound to a
    // specific user and cannot be replayed to mark another address verified.
    component docAndUser = Poseidon(2);
    docAndUser.inputs[0] <== documentHash;
    docAndUser.inputs[1] <== userId;

    // Bind the user-bound document to the issuing authority.
    component docAndKey = Poseidon(2);
    docAndKey.inputs[0] <== docAndUser.out;
    docAndKey.inputs[1] <== authorityPublicKey;

    // Authority-issued commitment:
    //   authorityCommitment === Poseidon(Poseidon(Poseidon(documentHash, userId), authorityPublicKey), issuerSignature)
    component commitment = Poseidon(2);
    commitment.inputs[0] <== docAndKey.out;
    commitment.inputs[1] <== issuerSignature;
    commitment.out === authorityCommitment;
}

// Fold N signals through N-1 chained Poseidon(2) hashes.
template Fold(N) {
    signal input values[N];
    signal output out;
    signal acc[N-1];
    component hashers[N-1];
    hashers[0] = Poseidon(2);
    hashers[0].inputs[0] <== values[0];
    hashers[0].inputs[1] <== values[1];
    acc[0] <== hashers[0].out;
    for (var i = 2; i < N; i++) {
        hashers[i-1] = Poseidon(2);
        hashers[i-1].inputs[0] <== acc[i-2];
        hashers[i-1].inputs[1] <== values[i];
        acc[i-1] <== hashers[i-1].out;
    }
    out <== acc[N-2];
}

// No public output: circom places outputs before public inputs, so keeping an
// isValid output would shadow userId and break KYCVerifier.verifyKYC's
// input[0] === user binding. userId is declared first so it lands at input[0];
// authorityCommitment is input[1]. The constraints above are the validity gate.
component main {public [userId, authorityCommitment]} = KYCVerification();
