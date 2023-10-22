import pandas as pd
import numpy as np
import scipy.stats as stats
import matplotlib.pyplot as plt
import seaborn as sns
import tkinter as tk
from tkinter import filedialog
from tkinter import messagebox

# Load the CSV file into a pandas DataFrame
root = tk.Tk()
root.withdraw()

try:
    file_path = filedialog.askopenfilename()
    df = pd.read_csv(file_path)
except FileNotFoundError:
    messagebox.showerror("Error", "File not found.")
    exit()
except pd.errors.EmptyDataError:
    messagebox.showerror("Error", "File is empty.")
    exit()
except pd.errors.ParserError:
    messagebox.showerror("Error", "Unable to parse file.")
    exit()
except:
    messagebox.showerror("Error", "An unexpected error occurred.")
    exit()

# Create the GUI window
window = tk.Tk()
window.title("COVID-19 Data Analysis Tool")

# Define functions for the analysis
def descriptive_statistics():
    try:
        # Calculate summary statistics using pandas
        summary = df.describe()
        # Display the results in the GUI
        result_label.config(text=str(summary))
    except:
        messagebox.showerror("Error", "Unable to perform analysis.")
        
def correlation_analysis():
    try:
        # Calculate the correlation matrix using pandas
        corr_matrix = df.corr()
        # Display the results in a heatmap using seaborn and matplotlib
        sns.heatmap(corr_matrix, annot=True, cmap='coolwarm')
        plt.show()
    except:
        messagebox.showerror("Error", "Unable to perform analysis.")
        
def hypothesis_testing():
    try:
        # Perform a t-test using scipy
        t_stat, p_value = stats.ttest_ind(df['New_cases'], df['New_deaths'])
        # Display the results in the GUI
        result_label.config(text="t-statistic: {:.2f}\np-value: {:.2f}".format(t_stat, p_value))
    except:
        messagebox.showerror("Error", "Unable to perform analysis.")
        
def regression_analysis():
    try:
        # Perform a linear regression using numpy and scipy
        x = df['New_cases']
        y = df['New_deaths']
        slope, intercept, r_value, p_value, std_err = stats.linregress(x, y)
        line = slope * x + intercept
        # Display the results in a scatter plot using seaborn and matplotlib
        sns.scatterplot(x=x, y=y)
        plt.plot(x, line, color='r')
        plt.show()
    except:
        messagebox.showerror("Error", "Unable to perform analysis.")

# Create buttons to call the analysis functions
descriptive_button = tk.Button(window, text="Descriptive Statistics", command=descriptive_statistics)
descriptive_button.pack()

correlation_button = tk.Button(window, text="Correlation Analysis", command=correlation_analysis)
correlation_button.pack()

hypothesis_button = tk.Button(window, text="Hypothesis Testing", command=hypothesis_testing)
hypothesis_button.pack()

regression_button = tk.Button(window, text="Regression Analysis", command=regression_analysis)
regression_button.pack()

# Create a label to display the results
result_label = tk.Label(window, text="")
result_label.pack()

# Start the GUI main loop
window.mainloop()
