import unittest

from .voice_command_router import parse_voice_command


class ShutdownIntentTest(unittest.TestCase):
    def test_bare_shutdown_requires_clarification(self):
        parsed = parse_voice_command("shutdown")
        self.assertEqual(parsed.tool, "saraShutdownClarification")
        self.assertFalse(parsed.requires_confirmation)

    def test_self_shutdown_never_maps_to_power(self):
        parsed = parse_voice_command("shut yourself down")
        self.assertEqual(parsed.tool, "saraSelfShutdown")
        self.assertNotEqual(parsed.tool, "requestPowerAction")

    def test_close_sara_never_maps_to_power(self):
        parsed = parse_voice_command("close sara")
        self.assertEqual(parsed.tool, "saraSelfShutdown")
        self.assertNotEqual(parsed.tool, "requestPowerAction")

    def test_computer_shutdown_keeps_confirmation(self):
        parsed = parse_voice_command("shut down the computer")
        self.assertEqual(parsed.tool, "requestPowerAction")
        self.assertTrue(parsed.requires_confirmation)
        self.assertEqual(parsed.args["action"], "shutdown")

    def test_turn_off_and_power_off_variants_require_confirmation(self):
        for phrase in ["turn off the computer", "power off my pc", "power down the system", "restart my computer", "restart the system"]:
            parsed = parse_voice_command(phrase)
            self.assertEqual(parsed.tool, "requestPowerAction", phrase)
            self.assertTrue(parsed.requires_confirmation, phrase)
