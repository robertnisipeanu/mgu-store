// ssh for prompt_test.js on Windows: a head unit that needs a restart to
// finish setup. Each call appends its remote command (the last argument) to
// %FAKE_SSH_LOG%; stdin, when it is not the console, is read to its end.
// The coding check answers "ok", the status the updater not running, and
// everything else exits 0. `ssh -V` answers as OpenSSH 9.
using System;
using System.IO;

static class FakeSsh {
    static int Main(string[] args) {
        if (args.Length == 1 && args[0] == "-V") {
            Console.Error.WriteLine("OpenSSH_for_Windows_9.5p1");
            return 0;
        }
        string remote = args.Length > 0 ? args[args.Length - 1] : "";
        File.AppendAllText(Environment.GetEnvironmentVariable("FAKE_SSH_LOG"), remote.Replace("\n", " ") + "\n");
        if (Console.IsInputRedirected) {
            Console.OpenStandardInput().CopyTo(Stream.Null);
        }
        if (remote.Contains("rawcodingdata")) {
            Console.WriteLine("ok");
        } else if (remote.Contains(" status >&2")) {
            Console.Error.WriteLine("mgu-deploy status");
            Console.WriteLine("inactive");
        }
        return 0;
    }
}
