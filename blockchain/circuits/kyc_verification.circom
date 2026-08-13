pragma circom 2.0.0;

include "./poseidon.circom";

// ZK-SNARK circuit for KYC verification.
//
// `verified` is no longer a prover-supplied input. The prover must know the
// raw document fields and an issuer signature issued by the authority over the
// resulting documentHash, such that:
//   Poseidon(Poseidon(documentHash, authorityPublicKey), issuerSignature) === authorityCommitment
// authorityPublicKey and authorityCommitment are public inputs so the verifier
// contract can bind them to the authority's on-chain identity.
template KYCVerification() {
    signal input documentHash;
    signal input authorityPublicKey;
    signal input authorityCommitment;
    signal input issuerSignature;
    signal input name[100];
    signal input licenseNumber[50];
    signal input rcNumber[50];
    signal input insuranceNumber[50];
    signal output isValid;

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

    // Bind documentHash to an authority-issued commitment:
    //   authorityCommitment === Poseidon(Poseidon(documentHash, authorityPublicKey), issuerSignature)
    component docAndKey = Poseidon(2);
    docAndKey.inputs[0] <== documentHash;
    docAndKey.inputs[1] <== authorityPublicKey;

    component commitment = Poseidon(2);
    commitment.inputs[0] <== docAndKey.out;
    commitment.inputs[1] <== issuerSignature;
    commitment.out === authorityCommitment;

    // isValid is derived, never a prover input: a proof exists only when every
    // constraint above holds (document committed, authority commitment matched).
    isValid <== 1;
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

component main {public [authorityPublicKey, authorityCommitment]} = KYCVerification();
