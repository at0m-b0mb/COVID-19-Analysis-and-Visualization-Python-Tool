import pandas as pd
import matplotlib.pyplot as plt

# read the CSV file into a pandas DataFrame
df = pd.read_csv('covid_data.csv')

# convert the 'Date_reported' column to a datetime object
df['Date_reported'] = pd.to_datetime(df['Date_reported'])

# group the data by country and date, and calculate the daily new cases and deaths
df_grouped = df.groupby(['Country', 'Date_reported']).agg({
    'New_cases': 'sum',
    'New_deaths': 'sum'
}).reset_index()

# calculate the 7-day rolling average of new cases and deaths for each country
df_grouped['New_cases_7day_rolling_avg'] = df_grouped.groupby('Country')['New_cases'].rolling(window=7).mean().reset_index(0, drop=True)
df_grouped['New_deaths_7day_rolling_avg'] = df_grouped.groupby('Country')['New_deaths'].rolling(window=7).mean().reset_index(0, drop=True)

# calculate the total cases and deaths for each country
df_total = df_grouped.groupby('Country').agg({
    'New_cases': 'sum',
    'New_deaths': 'sum'
}).reset_index()

# sort the data by total cases and deaths
df_total.sort_values(['New_cases', 'New_deaths'], ascending=False, inplace=True)

# create a bar chart of the top 10 countries by total cases
plt.figure(figsize=(10, 6))
plt.bar(df_total['Country'].head(10), df_total['New_cases'].head(10))
plt.xticks(rotation=90)
plt.title('Top 10 Countries by Total Cases')
plt.xlabel('Country')
plt.ylabel('Total Cases')
plt.show()

# create a line chart of the daily new cases for the US and India
df_us = df_grouped[df_grouped['Country'] == 'United States of America']
df_india = df_grouped[df_grouped['Country'] == 'India']
plt.figure(figsize=(10, 6))
plt.plot(df_us['Date_reported'], df_us['New_cases'], label='US')
plt.plot(df_india['Date_reported'], df_india['New_cases'], label='India')
plt.legend()
plt.title('Daily New Cases: US vs India')
plt.xlabel('Date')
plt.ylabel('New Cases')
plt.show()

# create a line chart of the 7-day rolling average of new cases for the top 5 countries
df_top5 = df_grouped[df_grouped['Country'].isin(df_total['Country'].head(5))]
plt.figure(figsize=(10, 6))
for country in df_top5['Country'].unique():
    df_country = df_top5[df_top5['Country'] == country]
    plt.plot(df_country['Date_reported'], df_country['New_cases_7day_rolling_avg'], label=country)
plt.legend()
plt.title('7-Day Rolling Average of New Cases: Top 5 Countries')
plt.xlabel('Date')
plt.ylabel('New Cases')
plt.show()

# create a line chart of the trend of new cases and new deaths over time for a specific country
country = 'India'
df_country = df_grouped[df_grouped['Country'] == country]
plt.figure(figsize=(10, 6))
plt.plot(df_country['Date_reported'], df_country['New_cases'], label='New Cases')
plt.plot(df_country['Date_reported'], df_country['New_deaths'], label='New Deaths')
plt.legend()
plt.title(f'Trend of New Cases and New Deaths over Time: {country}')
plt.xlabel('Date')
plt.ylabel('Number')
plt.show()

# create a bar chart of the top 10 countries by new cases and new deaths for a specific date
date = '2022-04-30'
df_date = df_grouped[df_grouped['Date_reported'] == date]
df_date.sort_values(['New_cases', 'New_deaths'], ascending=False, inplace=True)
plt.figure(figsize=(10, 6))
plt.bar(df_date['Country'].head(10), df_date['New_cases'].head(10))
plt.xticks(rotation=90)
plt.title(f'Top 10 Countries by New Cases on {date}')
plt.xlabel('Country')
plt.ylabel('New Cases')
plt.show()

plt.figure(figsize=(10, 6))
plt.bar(df_date['Country'].head(10), df_date['New_deaths'].head(10))
plt.xticks(rotation=90)
plt.title(f'Top 10 Countries by New Deaths on {date}')
plt.xlabel('Country')
plt.ylabel('New Deaths')
plt.show()

# calculate the daily growth rate of new cases and new deaths for a specific country
country_name = 'India'

# filter the data for the specified country
df_country = df_grouped[df_grouped['Country'] == country_name]

# calculate the daily growth rate of new cases and new deaths
df_country['New_cases_growth_rate'] = df_country['New_cases'].pct_change()
df_country['New_deaths_growth_rate'] = df_country['New_deaths'].pct_change()

# plot the growth rates
plt.figure(figsize=(10, 6))
plt.plot(df_country['Date_reported'], df_country['New_cases_growth_rate'], label='New Cases Growth Rate')
plt.plot(df_country['Date_reported'], df_country['New_deaths_growth_rate'], label='New Deaths Growth Rate')
plt.legend()
plt.title(f'Daily Growth Rates of New Cases and Deaths: {country_name}')
plt.xlabel('Date')
plt.ylabel('Growth Rate')
plt.show()

# Plot the trend of CFR for the top 10 countries by total cases
plt.figure(figsize=(10, 6))
df_top10 = df_total.head(10)
for country in df_top10['Country']:
    df_country = df[df['Country'] == country]
    cfr = df_country['Cumulative_deaths'] / df_country['Cumulative_cases']
    plt.plot(df_country['Date_reported'], cfr, label=country)
plt.legend()
plt.title('Case Fatality Rate: Top 10 Countries')
plt.xlabel('Date')
plt.ylabel('CFR')
plt.show()

# Calculate the percentage of increase in new cases and new deaths from the previous day for a specific country:
country = 'India'
df_country.loc[:, 'New_cases_pct_increase'] = df_country['New_cases'].pct_change() * 100
df_country.loc[:, 'New_deaths_pct_increase'] = df_country['New_deaths'].pct_change() * 100

# Plot the trend of percentage increase in new cases and new deaths
plt.figure(figsize=(10, 5))
plt.plot(df_country['Date_reported'], df_country['New_cases_pct_increase'], label='New Cases % Increase')
plt.plot(df_country['Date_reported'], df_country['New_deaths_pct_increase'], label='New Deaths % Increase')
plt.xlabel('Date')
plt.ylabel('Percentage Increase')
plt.title(f'Trend of Percentage Increase in New Cases and New Deaths in {country}')
plt.legend()
plt.show()

