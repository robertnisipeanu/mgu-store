using System;

namespace BaboCoding
{
    internal enum SimulationAction
    {
        ConnectionCheck,
        StoreInstall,
        UsbPreparation
    }

    internal static class SimulationService
    {
        public static string Describe(SimulationAction action)
        {
            switch (action)
            {
                case SimulationAction.ConnectionCheck:
                    return "SIMULATION: SSH check completed locally. No SSH process or network connection was started.";
                case SimulationAction.StoreInstall:
                    return "SIMULATION: the documented first-install flow is represented only. No command ran and the head unit was not changed.";
                case SimulationAction.UsbPreparation:
                    return "SIMULATION: the documented usb-repo flow is represented only. No local files were read or written.";
                default:
                    throw new ArgumentOutOfRangeException("action", action, "Unsupported simulation action.");
            }
        }
    }
}
