// Off-chain data DTOs (OpenAPI DataCommitment, DataCommitmentProof) and the API error shape.
using System.Collections.Generic;
using Newtonsoft.Json;

namespace Metafarm.Twin.Core.Models
{
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

    public sealed class BatchRef
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("leafIndex")] public int LeafIndex;
    }

    public sealed class DataCommitmentProof
    {
        [JsonProperty("commitment")] public DataCommitment Commitment;
        /// <summary>recorded, included or anchored (the platform does not produce anchored yet).</summary>
        [JsonProperty("state")] public string State;
        /// <summary>Null when the commitment is not in a batch.</summary>
        [JsonProperty("proof")] public MerkleProof Proof;
    }

    public sealed class MerkleProof
    {
        [JsonProperty("scheme")] public string Scheme;
        [JsonProperty("batchId")] public string BatchId;
        [JsonProperty("dataset")] public string Dataset;
        [JsonProperty("leaf")] public string Leaf;
        [JsonProperty("leafIndex")] public int LeafIndex;
        [JsonProperty("size")] public int Size;
        [JsonProperty("path")] public List<string> Path = new List<string>();
        [JsonProperty("root")] public string Root;
    }

    public sealed class ApiError
    {
        [JsonProperty("error")] public string Error;
        [JsonProperty("message")] public string Message;
        [JsonProperty("requestId")] public string RequestId;
    }
}
