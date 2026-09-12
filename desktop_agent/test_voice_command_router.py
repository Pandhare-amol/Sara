from __future__ import annotations

import unittest

from desktop_agent.voice_command_router import parse_to_dict


class VoiceCommandRouterTest(unittest.TestCase):
    def test_open_application(self) -> None:
        parsed = parse_to_dict("Open Chrome")
        self.assertEqual(parsed["tool"], "openApplication")
        self.assertEqual(parsed["args"]["name"], "chrome")
        self.assertFalse(parsed["requires_confirmation"])

    def test_power_requires_confirmation(self) -> None:
        parsed = parse_to_dict("Shutdown the computer")
        self.assertEqual(parsed["tool"], "requestPowerAction")
        self.assertTrue(parsed["requires_confirmation"])

    def test_file_delete_requires_confirmation(self) -> None:
        parsed = parse_to_dict("Delete temporary files")
        self.assertEqual(parsed["tool"], "deleteFile")
        self.assertTrue(parsed["requires_confirmation"])

    def test_keyboard_hotkey(self) -> None:
        parsed = parse_to_dict("Press Ctrl+S")
        self.assertEqual(parsed["tool"], "hardwareKeyboardPress")
        self.assertEqual(parsed["args"]["keys"], "Ctrl+S")

    def test_show_desktop_routes_to_sara_orchestrator(self) -> None:
        parsed = parse_to_dict("Show desktop")
        self.assertEqual(parsed["tool"], "saraAgentExecute")
        self.assertEqual(parsed["args"]["goal"], "Show desktop")

    def test_application_automation_routes_through_sara(self) -> None:
        parsed = parse_to_dict("Send a WhatsApp message to John")
        self.assertEqual(parsed["tool"], "saraAppExecuteGoal")
        self.assertTrue(parsed["requires_confirmation"])

    def test_camera_commands_route_to_camera_tools(self) -> None:
        self.assertEqual(parse_to_dict("Open the webcam")["tool"], "openCamera")
        self.assertEqual(parse_to_dict("Take a photo")["tool"], "takePhoto")
        self.assertEqual(parse_to_dict("Record video for 10 seconds")["tool"], "recordVideo")
        self.assertEqual(parse_to_dict("See what's in this")["tool"], "readScreen")
        self.assertEqual(parse_to_dict("Close all applications")["tool"], "closeAllApplications")
        self.assertEqual(parse_to_dict("Copy this")["tool"], "copySelected")
        self.assertEqual(parse_to_dict("Paste this")["tool"], "pasteClipboard")

    def test_goal_memory_and_emergency_routes(self) -> None:
        self.assertEqual(parse_to_dict("Create goal: launch startup")["tool"], "saraGoalCreate")
        self.assertEqual(parse_to_dict("Forget this project")["tool"], "saraMemoryForget")
        self.assertEqual(parse_to_dict("Emergency stop")["tool"], "saraAgentEmergencyStop")
        self.assertEqual(parse_to_dict("Teach SARA my Word workflow")["tool"], "saraLearningTeach")

    def test_context_follow_up_and_interruptions(self) -> None:
        parsed = parse_to_dict("Now open the SARA project", {"last_app": "vscode"})
        self.assertEqual(parsed["tool"], "openApplication")
        self.assertEqual(parsed["args"]["name"], "vscode")
        self.assertEqual(parse_to_dict("SARA, stop")["tool"], "saraVoiceStopSpeaking")
        self.assertEqual(parse_to_dict("Suggest next step", {"last_goal": "Build report"})["tool"], "saraCompanionSuggestNext")

    def test_youtube_play_routes_to_verified_playback(self) -> None:
        parsed = parse_to_dict("Sara, open YouTube and play a Python lecture")
        self.assertEqual(parsed["tool"], "youtube_play")
        self.assertEqual(parsed["args"]["query"], "a Python lecture")

    def test_expanded_file_browser_and_app_voice_routes(self) -> None:
        self.assertEqual(parse_to_dict("List downloads")["tool"], "listFiles")
        self.assertEqual(parse_to_dict("Read file Desktop\\notes.txt")["tool"], "readFile")
        self.assertEqual(parse_to_dict("Rename Desktop\\old.txt to new.txt")["tool"], "renameFile")
        self.assertEqual(parse_to_dict("Copy Desktop\\a.txt to Documents")["tool"], "copyFile")
        self.assertEqual(parse_to_dict("Research best laptops")["tool"], "saraBrowserExecuteGoal")
        self.assertEqual(parse_to_dict("Open Word")["tool"], "openApplication")
        self.assertEqual(parse_to_dict("Open Word")["args"]["name"], "word")


if __name__ == "__main__":
    unittest.main()

