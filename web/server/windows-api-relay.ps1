# One SSH process transports bounded API channels to the existing native named pipe.
# This is an IPC client only: it never starts, installs, or stops a Herdr server.
param([Parameter(Mandatory=$true)][string]$PipeName)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
public static class WerdrApiRelay {
    static readonly ConcurrentDictionary<string, NamedPipeClientStream> Channels = new();
    static readonly object OutputLock = new();
    static StreamWriter Output;
    static void Emit(object value) {
        lock (OutputLock) { Output.WriteLine(JsonSerializer.Serialize(value)); Output.Flush(); }
    }
    static async Task Run(string pipeName, string id, string request, NamedPipeClientStream pipe) {
        try {
            await pipe.ConnectAsync(5000);
            var bytes = Encoding.UTF8.GetBytes(request + "\n");
            await pipe.WriteAsync(bytes, 0, bytes.Length); await pipe.FlushAsync();
            using var reader = new StreamReader(pipe, new UTF8Encoding(false, true), false, 4096, true);
            // Read incrementally with an explicit cap instead of unbounded ReadLine.
            var line = new StringBuilder(); var buffer = new char[4096];
            int length;
            while ((length = await reader.ReadAsync(buffer, 0, buffer.Length)) > 0) {
                for (int i = 0; i < length; i++) {
                    if (buffer[i] == '\n') {
                        using var json = JsonDocument.Parse(line.ToString());
                        Emit(new { channel = id, message = json.RootElement.Clone() }); line.Clear();
                    } else {
                        line.Append(buffer[i]);
                        if (line.Length > 8 * 1024 * 1024) throw new IOException("Frame too large");
                    }
                }
            }
        } catch { try { Emit(new { channel = id, error = "Native API connection closed" }); } catch {} }
        finally {
            Channels.TryRemove(id, out _); pipe.Dispose();
            try { Emit(new { channel = id, closed = true }); } catch {}
        }
    }
    public static void Start(string pipeName) {
        Output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        using var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true));
        try {
            string line;
            while ((line = input.ReadLine()) != null) {
                if (line.Length > 128 * 1024) throw new IOException("Request too large");
                using var json = JsonDocument.Parse(line);
                var root = json.RootElement; var id = root.GetProperty("channel").GetString();
                if (String.IsNullOrEmpty(id) || id.Length > 80) throw new IOException("Invalid channel");
                if (root.TryGetProperty("cancel", out var cancel) && cancel.GetBoolean()) {
                    if (Channels.TryRemove(id, out var old)) old.Dispose();
                    continue;
                }
                if (Channels.Count >= 32) { Emit(new { channel = id, error = "API channel limit reached" }); continue; }
                var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
                if (!Channels.TryAdd(id, pipe)) { pipe.Dispose(); throw new IOException("Duplicate channel"); }
                _ = Run(pipeName, id, root.GetProperty("request").GetRawText(), pipe);
            }
        } finally { foreach (var pipe in Channels.Values) pipe.Dispose(); Channels.Clear(); }
    }
}
'@
[WerdrApiRelay]::Start($PipeName)
