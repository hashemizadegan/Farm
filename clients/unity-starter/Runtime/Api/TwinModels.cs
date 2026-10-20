// Data transfer objects for the Metafarm digital-twin API (/v1/tenants/{tenantId}/twin/*).
// They mirror packages/contracts/openapi.yaml (schemas Twin*, DataCommitment*, TransferPreview).
// Deserialise with Newtonsoft.Json (Unity package com.unity.nuget.newtonsoft-json): JsonUtility
// cannot read nullable fields or GeoJSON coordinates.
//
// Amounts and slots are strings: they are u64 values that do not fit a double.
using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Metafarm.Twin.Api
{
    [Serializable]
    public sealed class TwinScene
    {
        [JsonProperty("scheme")] public string Scheme;            // "metafarm-twin-scene/1"
        [JsonProperty("generatedAt")] public string GeneratedAt;
        [JsonProperty("farm")] public TwinFarm Farm;
        /// Layers this account may not see (assets need the rwa:read permission).
        [JsonProperty("redacted")] public List<string> Redacted = new();
        [JsonProperty("objects")] public List<TwinObject> Objects = new();
        [JsonProperty("nextCursor")] public string NextCursor;    // null on the last page
    }

    [Serializable]
    public sealed class TwinFarm
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("name")] public string Name;
        [JsonProperty("origin")] public LonLat Origin;            // may be null
        /// Simplified outer ring of the current boundary, [lon, lat] pairs; may be null.
        [JsonProperty("outline")] public List<double[]> Outline;
    }

    [Serializable]
    public sealed class LonLat
    {
        [JsonProperty("lon")] public double Lon;
        [JsonProperty("lat")] public double Lat;
    }

    [Serializable]
    public sealed class TwinObject
    {
        [JsonProperty("twinObjectId")] public string TwinObjectId;   // "asset:<assetId>"
        [JsonProperty("assetId")] public string AssetId;
        [JsonProperty("layer")] public string Layer;                 // plots, crops_trees, buildings, ...
        [JsonProperty("kind")] public string Kind;                   // parcel, tree, building, ...
        [JsonProperty("name")] public string Name;
        [JsonProperty("status")] public string Status;
        /// GeoJSON (WGS 84): Point or Polygon, or null.
        [JsonProperty("geometry")] public JObject Geometry;
        [JsonProperty("physical")] public PhysicalIdentity Physical;
        [JsonProperty("chain")] public List<ChainIdentity> Chain = new();
    }

    [Serializable]
    public sealed class PhysicalIdentity
    {
        [JsonProperty("externalRef")] public string ExternalRef;
        [JsonProperty("parcelLabel")] public string ParcelLabel;
        [JsonProperty("geomProvenance")] public string GeomProvenance;
        [JsonProperty("verifiedAt")] public string VerifiedAt;
    }

    [Serializable]
    public sealed class ChainIdentity
    {
        [JsonProperty("representationId")] public string RepresentationId;
        [JsonProperty("rail")] public string Rail;                   // SOLANA_TOKEN_2022, SOLANA_BUBBLEGUM_CNFT, TRON_TRC20
        [JsonProperty("network")] public string Network;             // solana-devnet, ...
        [JsonProperty("status")] public string Status;
        [JsonProperty("chainId")] public string ChainId;             // mint or asset id; null until known
    }

    [Serializable]
    public sealed class TwinAssetDetail
    {
        [JsonProperty("object")] public TwinObject Object;
        [JsonProperty("lifecycle")] public List<LifecycleEvent> Lifecycle = new();
        [JsonProperty("ownership")] public List<Ownership> Ownership = new();
        [JsonProperty("dataCommitments")] public List<DataCommitment> DataCommitments = new();
    }

    [Serializable]
    public sealed class LifecycleEvent
    {
        [JsonProperty("event")] public string Event;                 // registered, verified
        [JsonProperty("at")] public string At;
    }

    /// Ownership of one representation, as the chain (or an indexer of it) reports it.
    /// Show "not indexed" as unknown, never as "nobody".
    [Serializable]
    public sealed class Ownership
    {
        [JsonProperty("representationId")] public string RepresentationId;
        [JsonProperty("status")] public string Status;               // indexed, not_indexed, not_on_chain
        [JsonProperty("reason")] public string Reason;               // when not_indexed
        [JsonProperty("source")] public string Source;               // chain_index, das, fixture
        [JsonProperty("assurance")] public string Assurance;         // inclusion_verified, indexer_reported, fixture
        [JsonProperty("asOfSlot")] public string AsOfSlot;
        [JsonProperty("holders")] public List<Holder> Holders = new();

        public bool IsKnown => Status == "indexed";
        public bool IsTestData => Source == "fixture";
    }

    [Serializable]
    public sealed class Holder
    {
        [JsonProperty("owner")] public string Owner;
        [JsonProperty("amount")] public string Amount;
    }

    [Serializable]
    public sealed class DataCommitment
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("farmId")] public string FarmId;
        [JsonProperty("subjectType")] public string SubjectType;
        [JsonProperty("subjectId")] public string SubjectId;
        [JsonProperty("schema")] public string Schema;
        [JsonProperty("schemaVersion")] public int SchemaVersion;
        [JsonProperty("contentSha256")] public string ContentSha256;
        [JsonProperty("byteSize")] public long? ByteSize;
        [JsonProperty("storageRef")] public string StorageRef;
        [JsonProperty("sourceTime")] public string SourceTime;
        [JsonProperty("attestationRef")] public string AttestationRef;
        [JsonProperty("batch")] public BatchRef Batch;
        [JsonProperty("createdAt")] public string CreatedAt;
    }

    [Serializable]
    public sealed class BatchRef
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("leafIndex")] public int LeafIndex;
    }

    [Serializable]
    public sealed class ApiError
    {
        [JsonProperty("error")] public string Error;
        [JsonProperty("message")] public string Message;
        [JsonProperty("requestId")] public string RequestId;
    }
}
