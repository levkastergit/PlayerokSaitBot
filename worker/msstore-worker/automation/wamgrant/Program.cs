// wamgrant — интерактивный грант MSA-токена через WAM HWND-interop (desktop).
// Назначение: добыть serviceTicket для beneficiaries/me/keys, который тихо не
// выдаётся (DELEGATION -> USER_INTERACTION_REQUIRED). Показывает окно согласия
// один раз, печатает СТАТУС и ДЛИНУ токена (проверка гипотезы 1662). Полный
// токен пишется в файл только с флагом --emit (это твой токен, не выкладывать).
//
// Сборка/запуск (нужен .NET 8 SDK):
//   dotnet run --project worker/msstore-worker/automation/wamgrant -- <scope> [clientId]
// По умолчанию перебирает DELEGATION-scope для collections и purchase.
//
// Это тот же штатный API, которым Store берёт свои токены, для СВОЕГО MSA.

using System;
using System.IO;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using Windows.Security.Authentication.Web.Core;
using Windows.Security.Credentials;

internal static class Program
{
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetConsoleWindow();

    private static readonly string[] DefaultScopes =
    {
        "service::collections.mp.microsoft.com::DELEGATION",
        "service::purchase.mp.microsoft.com::DELEGATION",
    };

    private const string StoreClient = "000000004824A775";

    private static async Task<int> Main(string[] args)
    {
        string emitPath = null;
        string oneScope = null;
        string clientId = StoreClient;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--emit" && i + 1 < args.Length) { emitPath = args[++i]; }
            else if (oneScope == null) { oneScope = args[i]; }
            else { clientId = args[i]; }
        }

        var provider = await WebAuthenticationCoreManager.FindAccountProviderAsync("https://login.live.com");
        if (provider == null)
        {
            Console.WriteLine("[!] MSA-провайдер WAM не найден (login.live.com).");
            return 2;
        }
        Console.WriteLine($"[*] provider: {provider.DisplayName}");
        IntPtr hwnd = GetConsoleWindow();
        Console.WriteLine($"[*] console HWND: {hwnd}");

        var scopes = oneScope != null ? new[] { oneScope } : DefaultScopes;
        foreach (var scope in scopes)
        {
            Console.WriteLine($"\n[*] RequestTokenForWindow: client={clientId} scope={scope}");
            Console.WriteLine("    (если появится окно согласия — подтверди вход)");
            WebTokenRequestResult result;
            try
            {
                var req = new WebTokenRequest(provider, scope, clientId);
                result = await WebAuthenticationCoreManagerInterop
                    .RequestTokenForWindowAsync(hwnd, req);
            }
            catch (Exception e)
            {
                Console.WriteLine($"    ОШИБКА: {e.GetType().Name}: {e.Message}");
                continue;
            }

            Console.WriteLine($"    status = {result.ResponseStatus}");
            if (result.ResponseStatus == WebTokenRequestStatus.Success && result.ResponseData.Count > 0)
            {
                string tok = result.ResponseData[0].Token;
                int n = tok?.Length ?? 0;
                string flag = (n >= 1600 && n <= 1720) ? "  <<< 1662 = serviceTicket!" : "";
                Console.WriteLine($"    SUCCESS len={n} prefix={tok?.Substring(0, Math.Min(16, n))}{flag}");
                if (emitPath != null)
                {
                    File.AppendAllText(emitPath, $"{scope}\t{tok}\n");
                    Console.WriteLine($"    -> записан в {emitPath} (НЕ выкладывай)");
                }
            }
            else if (result.ResponseError != null)
            {
                Console.WriteLine($"    error = 0x{result.ResponseError.ErrorCode:X8} {result.ResponseError.ErrorMessage}");
            }
        }
        return 0;
    }
}
