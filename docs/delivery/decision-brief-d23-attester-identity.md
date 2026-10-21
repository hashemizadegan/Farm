# Decision Brief: D-23 Attester Identity Requirements

**Status: OPEN — FOR REVIEW ONLY (NO APPROVALS).** Nothing in this brief is approved, and it designs no
implementation. It does not change [`real-yield-distribution-plan.md`](real-yield-distribution-plan.md).

## Context

- **Code state:**
  - The Y1, Y2 and Y3 work exists only as draft PRs, and CI passes on all of them:
    - #60 (Y1), head `2bbc68e`, 13/13;
    - #61 (Y2), head `e90142b`, 13/13;
    - #62 (stack base), head `e709cf8`, 14/14;
    - #63 (Y3), head `4d08b9a`, 14/14.
  - The plan document itself is unchanged.
- **Defect already fixed (Y3):**
  - Node's Web Crypto accepted Ed25519 signatures made with small-order public keys. With the identity
    point as the key, the signature (R = identity, S = 0) verified for any message.
  - Small-order and non-canonical keys are now rejected as `malformed_key`, with regression tests.
- **Open gap, the subject of this brief:**
  - A valid signature proves only that the holder of that key signed. Nothing binds the key to the
    attester name on the attestation.
  - So one actor could use several keys under different attester names and satisfy a quorum alone.

## 1. Problem statement and threat model

**Problem:** D-23 must decide what an "attester" is, and what makes an attestation count as coming from
that attester. Until then, a counted attester is just a name the submitter chose.

**Threats:**

- **Sybil quorum filling:** one actor uses many keys or names to make up a multi-attester quorum. This is
  the main risk.
- **Impersonation:** someone attests under a real attester's name with a key that attester doesn't
  control.
- **Key compromise:** a stolen key produces valid-looking attestations until someone detects it and acts.
- **Key rotation:** a legitimate key change must not invalidate past attestations, or let an old key keep
  attesting.
- **Revocation:**
  - who can revoke an attester, a key or an individual attestation;
  - whether revocation applies to new attestations only or also to past ones;
  - what happens to cycles that relied on a revoked key.
- **Collusion and independence:** distinct identities can still be one interest, such as the same firm or
  the operator itself. A quorum of distinct names doesn't prove independent judgement.
- **Auditability:** a reviewer or auditor must be able to reconstruct, after the fact, who attested, under
  which identity, which key, and which approval was in force at the time.

## 2. Decision options (policy level)

- **Option A: attester = key.** The key itself is the identity, with no named entity behind it.
- **Option B: attester = named entity with an approved key registry.** Keys are credentials issued to an
  approved attester.
- **Option C: hybrid.** A named entity holds several keys, and an attestation from that entity needs a
  quorum of its own keys.
- **Option D: delegated trust.** Identity is vouched for by an external credential issuer (for example a
  professional body or certificate authority) whose credentials the platform accepts.

## 3. Option analysis

### Option A: attester = key

- **Enables:** the simplest model, with no onboarding or registry, and fully self-contained verification.
- **Fails to prevent:** Sybil quorum filling, since keys cost nothing. It also gives no protection
  against impersonation, because no named party is bound.
- **Operational burden:** minimal.
- **Failure modes:**
  - a quorum becomes a count of keys, not of people or organisations;
  - losing a key loses the identity;
  - nothing ties an attestation to legal accountability.
- **Fit:** suitable at most for simulation or demonstration use. It doesn't fix the recorded gap.

### Option B: named entity with an approved key registry

- **Enables:** a quorum counted by approved entities, an accountable party behind every attestation,
  rotation and revocation by governance, and a clear audit trail.
- **Fails to prevent:**
  - collusion between approved entities;
  - a key compromised within its validity window;
  - registry approvers who are themselves compromised or captured.
- **Operational burden:** medium to high. It needs onboarding, identity vetting, a key-approval process
  (possibly four-eyes), and rotation and revocation handling.
- **Failure modes:**
  - the registry becomes the single point of trust;
  - approvals that lag behind reality, such as a departed staff member's key still being valid;
  - if a key is reassigned, it's ambiguous who signed earlier attestations.

### Option C: hybrid (an entity's own internal quorum)

- **Enables:** everything in B, plus resistance to a single compromised key inside an organisation, and
  internal separation of duties.
- **Fails to prevent:** collusion within the entity or between entities. It does nothing more than B
  against approvers being compromised.
- **Operational burden:** highest. Each entity manages several keys, and the platform tracks both
  entity-level and platform-level quorums.
- **Failure modes:**
  - complexity leads to misconfiguration, such as an internal quorum of 1 that quietly becomes Option B;
  - liveness problems: an entity can't attest when it loses keys;
  - disputes over how much each individual signer is responsible for.

### Option D: delegated trust

- **Enables:** reuse of existing professional or legal identity schemes, less vetting work for the
  platform, and stronger legal standing where a recognised issuer exists.
- **Fails to prevent:** problems on the issuer's side (wrong issuance, slow revocation). Sybil
  resistance is only as good as the issuer's process.
- **Operational burden:** medium. Issuers must be selected and approved, credential validity checked, and
  the issuer's revocation status tracked.
- **Failure modes:**
  - no suitable issuer exists for some attester roles or regions;
  - a dependency on the issuer's availability and terms;
  - mixed regimes across asset classes.

## 4. Artifacts required for approval

- **Counsel (L):**
  - which attester roles carry legal weight, and the liability of attesters;
  - whether identity must be a legal person, a natural person or either;
  - recordkeeping and retention obligations for identity evidence;
  - the data-protection basis for holding attester identity data.
- **Security (S, proposed):**
  - a threat model covering Sybil attacks, impersonation and compromise;
  - key custody expectations for attesters;
  - requirements for rotation, revocation and incident response;
  - who may approve or revoke attesters, and under what controls (for example four-eyes).
- **Product (P):**
  - attester roles per asset class, with expected numbers of attesters and their independence;
  - onboarding experience and the acceptable burden;
  - how attestations and identities are shown to reviewers.
- **Technical (T):**
  - the accepted signature methods and key types;
  - what must be recorded to make identity, key and approval state reconstructable at any past time;
  - how revocation affects cycles already approved;
  - limits on how quickly identity status may change.
- **Cross-functional:** a written definition of "independent attesters" for quorum purposes, per asset
  class.

## 5. Non-goals and blocked scope

**Non-goals of this brief:**

- implementation design, data models, code, migrations or tooling;
- operational procedures for onboarding or key handling;
- choosing quorum sizes or roles per asset class (separate D-23 values);
- any change to deployments, holds, chain access or signing posture.

**Blocked until D-23 is approved:**

- treating key-signature attestations as identity-bearing for any non-simulation use;
- relying on attester counts in a quorum as evidence of distinct parties;
- any attester onboarding, registry or credential design work;
- final semantics for revoking attesters, keys or attestations.

**Not blocked:** simulation-only use, where the identity gap is acknowledged.

## 6. Recommended next questions

1. Is an attester a natural person, a legal entity, or either, and does that differ by role?
2. Must attesters be independent of the operator and of each other, and how is independence defined and
   evidenced?
3. Who has authority to approve, suspend and revoke attesters and their keys, and does that require
   four-eyes?
4. When a key is revoked or found compromised, do past attestations made with it stay valid, become void,
   or trigger review of affected cycles?
5. May one entity fill more than one role in the same quorum?
6. Is an internal multi-key quorum (Option C) required for any role, or only optional?
7. Are external credential issuers (Option D) acceptable, and if so which kinds and for which roles?
8. Do the identity requirements also apply to non-cryptographic attestation methods, or only to key
   signatures?
9. What attester identity data may be stored, for how long, and who may see it?
10. Do the requirements differ between simulation, devnet and production stages?
