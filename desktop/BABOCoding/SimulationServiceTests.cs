using System;

namespace BaboCoding
{
    internal static class SimulationServiceTests
    {
        private static int Main()
        {
            Expect(
                SimulationService.Describe(SimulationAction.ConnectionCheck),
                "No SSH process or network connection was started.");
            Expect(
                SimulationService.Describe(SimulationAction.StoreInstall),
                "No command ran and the head unit was not changed.");
            Expect(
                SimulationService.Describe(SimulationAction.UsbPreparation),
                "No local files were read or written.");
            ExpectInvalidAction();
            Console.WriteLine("Simulation tests passed.");
            return 0;
        }

        private static void Expect(string result, string requiredText)
        {
            if (result.IndexOf("SIMULATION:", StringComparison.Ordinal) != 0 ||
                result.IndexOf(requiredText, StringComparison.Ordinal) < 0)
            {
                throw new InvalidOperationException("Unexpected simulation result: " + result);
            }
        }

        private static void ExpectInvalidAction()
        {
            try
            {
                SimulationService.Describe((SimulationAction)999);
            }
            catch (ArgumentOutOfRangeException)
            {
                return;
            }

            throw new InvalidOperationException("Unknown simulation actions must fail explicitly.");
        }
    }
}
