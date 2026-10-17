import { expect } from "chai";
import { ethers } from "hardhat";

describe("HarvestRegistry", () => {
  const batch = ethers.zeroPadValue("0x0b3c5d7e9f1a2b4c6d8e0f1a2b3c4d5e", 32);
  const hash = ethers.sha256(ethers.toUtf8Bytes('{"batch":"HB7K3Q9X2M","v":1}'));

  async function deploy() {
    const [admin, recorder, stranger] = await ethers.getSigners();
    const F = await ethers.getContractFactory("HarvestRegistry");
    const c = await F.deploy(admin.address, recorder.address);
    return { c, admin, recorder, stranger };
  }

  it("lets only the recorder register, once, and never overwrite", async () => {
    const { c, admin, recorder, stranger } = await deploy();
    await expect(c.connect(stranger).record(batch, hash)).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    // The admin manages roles but does not record implicitly.
    await expect(c.connect(admin).record(batch, hash)).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    await expect(c.connect(recorder).record(batch, hash)).to.emit(c, "BatchRecorded").withArgs(batch, hash, recorder.address);
    const other = ethers.sha256(ethers.toUtf8Bytes("tampered"));
    await expect(c.connect(recorder).record(batch, other)).to.be.revertedWithCustomError(c, "AlreadyRecorded").withArgs(batch);
    const [h, at, voided] = await c.entryOf(batch);
    expect(h).to.equal(hash);
    expect(at).to.be.greaterThan(0n);
    expect(voided).to.equal(0n);
  });

  it("rejects empty ids and hashes", async () => {
    const { c, recorder } = await deploy();
    await expect(c.connect(recorder).record(ethers.ZeroHash, hash)).to.be.revertedWithCustomError(c, "ZeroValue");
    await expect(c.connect(recorder).record(batch, ethers.ZeroHash)).to.be.revertedWithCustomError(c, "ZeroValue");
  });

  it("voids a recorded batch once and keeps its fingerprint", async () => {
    const { c, recorder } = await deploy();
    const reason = ethers.sha256(ethers.toUtf8Bytes("recorded in error"));
    await expect(c.connect(recorder).voidBatch(batch, reason)).to.be.revertedWithCustomError(c, "NotRecorded");
    await c.connect(recorder).record(batch, hash);
    await expect(c.connect(recorder).voidBatch(batch, reason)).to.emit(c, "BatchVoided").withArgs(batch, reason, recorder.address);
    await expect(c.connect(recorder).voidBatch(batch, reason)).to.be.revertedWithCustomError(c, "AlreadyVoided");
    const [h, , voided] = await c.entryOf(batch);
    expect(h).to.equal(hash);
    expect(voided).to.be.greaterThan(0n);
  });

  it("is not a token: nothing can be owned, transferred or minted", async () => {
    const { c } = await deploy();
    const names = c.interface.fragments.map((f) => ("name" in f ? f.name : "")).filter(Boolean);
    for (const forbidden of ["transfer", "transferFrom", "balanceOf", "ownerOf", "mint", "approve", "totalSupply", "delete", "update", "setHash"]) {
      expect(names).to.not.include(forbidden);
    }
  });

  it("returns zeros for unknown batches", async () => {
    const { c } = await deploy();
    const [h, at, voided] = await c.entryOf(batch);
    expect([h, at, voided]).to.deep.equal([ethers.ZeroHash, 0n, 0n]);
  });

  it("refuses a zero admin or recorder at deployment", async () => {
    const [a] = await ethers.getSigners();
    const F = await ethers.getContractFactory("HarvestRegistry");
    await expect(F.deploy(ethers.ZeroAddress, a.address)).to.be.revertedWithCustomError(F, "ZeroValue");
  });
});
