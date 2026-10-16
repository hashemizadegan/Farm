import { expect } from "chai";
import { ethers } from "hardhat";

describe("FarmProjectCollectible (ERC-721)", () => {
  async function deploy(maxSupply = 3) {
    const [admin, minter, pauser, alice, bob, stranger] = await ethers.getSigners();
    const F = await ethers.getContractFactory("FarmProjectCollectible");
    const c = await F.deploy("Farm Project Collectible", "FPC", "https://example.invalid/meta/", maxSupply, admin.address, minter.address, pauser.address);
    return { c, admin, minter, pauser, alice, bob, stranger };
  }

  it("only lets MINTER_ROLE mint", async () => {
    const { c, minter, alice, stranger, admin } = await deploy();
    await expect(c.connect(stranger).mint(alice.address)).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    // The admin does not mint implicitly either.
    await expect(c.connect(admin).mint(alice.address)).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    await expect(c.connect(minter).mint(alice.address)).to.emit(c, "Transfer").withArgs(ethers.ZeroAddress, alice.address, 1n);
    expect(await c.ownerOf(1n)).to.equal(alice.address);
  });

  it("enforces a fixed maximum supply", async () => {
    const { c, minter, alice } = await deploy(2);
    await c.connect(minter).mint(alice.address);
    await c.connect(minter).mint(alice.address);
    await expect(c.connect(minter).mint(alice.address)).to.be.revertedWithCustomError(c, "MaxSupplyReached").withArgs(2n);
    expect(await c.maxSupply()).to.equal(2n);
  });

  it("rejects a zero max supply at deployment", async () => {
    const [a] = await ethers.getSigners();
    const F = await ethers.getContractFactory("FarmProjectCollectible");
    await expect(F.deploy("x", "x", "", 0, a.address, a.address, a.address)).to.be.revertedWithCustomError(F, "ZeroMaxSupply");
  });

  it("pause is an emergency stop for mints and transfers only, restricted to PAUSER_ROLE", async () => {
    const { c, minter, pauser, alice, bob, stranger } = await deploy();
    await c.connect(minter).mint(alice.address);
    await expect(c.connect(stranger).pause()).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    await c.connect(pauser).pause();
    await expect(c.connect(alice).transferFrom(alice.address, bob.address, 1n)).to.be.revertedWithCustomError(c, "EnforcedPause");
    await expect(c.connect(minter).mint(alice.address)).to.be.revertedWithCustomError(c, "EnforcedPause");
    // Ownership is untouched while paused.
    expect(await c.ownerOf(1n)).to.equal(alice.address);
    await c.connect(pauser).unpause();
    await c.connect(alice).transferFrom(alice.address, bob.address, 1n);
    expect(await c.ownerOf(1n)).to.equal(bob.address);
  });

  it("has no confiscation path: admin cannot move or burn a holder's token", async () => {
    const { c, minter, admin, alice, bob } = await deploy();
    await c.connect(minter).mint(alice.address);
    await expect(c.connect(admin).transferFrom(alice.address, bob.address, 1n)).to.be.revertedWithCustomError(c, "ERC721InsufficientApproval");
    const fragment = c.interface.fragments.map((f) => ("name" in f ? f.name : "")).filter(Boolean);
    for (const forbidden of ["burn", "adminTransfer", "forceTransfer", "confiscate", "seize", "blacklist", "blocklist", "setMaxSupply"]) {
      expect(fragment).to.not.include(forbidden);
    }
  });

  it("builds token URIs from the base URI", async () => {
    const { c, minter, alice } = await deploy();
    await c.connect(minter).mint(alice.address);
    expect(await c.tokenURI(1n)).to.equal("https://example.invalid/meta/1");
  });
});
