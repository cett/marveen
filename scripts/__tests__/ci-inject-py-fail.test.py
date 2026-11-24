import unittest


class TestInjectedFailureB4(unittest.TestCase):
    def test_fails_on_purpose(self):
        self.assertEqual(1, 2, "CI injection B4 (throwaway, never merged): a Python gate test must go red")


if __name__ == "__main__":
    unittest.main()
